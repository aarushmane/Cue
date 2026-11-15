// Finding items in the space.
//
// 1. By name: match the visitor's words against known items (same scoring as shopper product search).
// 2. From photos: a detection is a pixel in one of a sweep's skybox faces (or a bearing). Each detection becomes a
//    3D ray from that sweep's camera centre. Two or more rays from different sweeps are triangulated; a single ray is
//    intersected with the first shelf/fixture box it hits. Detections themselves (which pixel shows "chips") come
//    from a vision model or staff later — this module only does the geometry.
import { resolveProduct } from "../search/matchProducts";
import { FACES } from "./skybox";
import type { Product } from "../search/types";
import { add, normalize, rayHitsBox, rotate, scale, triangulate, v3, type Ray } from "./geometry";
import { raycast, type Surfaces } from "./mesh";
import type { Obstacle, SceneItem, Vec3, Waypoint } from "./types";

// ── By name ──────────────────────────────────────────────────────────────────────────────────────

export type ItemMatch =
  | { status: "MATCH"; item: SceneItem }
  | { status: "AMBIGUOUS"; options: SceneItem[] }
  | { status: "NO_MATCH" };

/** Resolve "where are the chips" to one item. Never guesses between equally good matches. */
export function findItem(query: string, items: SceneItem[]): ItemMatch {
  const asProducts = items.map((item) => ({
    id: item.id, storeId: "", name: item.name, brand: item.brand ?? null, variant: item.category ?? null, size: null,
    aliases: [...(item.aliases ?? []), ...(item.category ? [item.category] : [])], item,
  } satisfies Product & { item: SceneItem }));
  const result = resolveProduct(query, asProducts);
  if (result.status === "MATCH") return { status: "MATCH", item: result.product.item };
  if (result.status === "AMBIGUOUS") return { status: "AMBIGUOUS", options: result.options.map((o) => o.item) };
  return { status: "NO_MATCH" };
}

// ── From photo detections ────────────────────────────────────────────────────────────────────────

export type Detection = (
  /** Pixel in a skybox face, normalised: u 0 = left edge → 1 = right edge, v 0 = top → 1 = bottom. */
  | { sweepId: string; face: number; u: number; v: number }
  /** Direction already in the model frame: heading on the floor (0° = +x, CCW) and elevation (up positive). */
  | { sweepId: string; headingDeg: number; elevationDeg: number }
) & { /** 0..1, how sure the detector was. Defaults to 1. */ confidence?: number };

const EYE_HEIGHT_M = 1.35;

function cameraOf(w: Waypoint): Vec3 {
  return w.camera ?? add(w.position, v3(0, 0, EYE_HEIGHT_M));
}

/** The 3D ray a detection describes, from the sweep's camera centre. */
export function detectionRay(w: Waypoint, d: Detection): Ray | null {
  if ("face" in d) {
    const face = FACES[d.face];
    if (!face || !w.rotation || !(d.u >= 0 && d.u <= 1 && d.v >= 0 && d.v <= 1)) return null;
    const local = add(add(face.fwd, scale(face.right, 2 * d.u - 1)), scale(face.up, 1 - 2 * d.v));
    return { origin: cameraOf(w), dir: normalize(rotate(w.rotation, local)) };
  }
  const h = (d.headingDeg * Math.PI) / 180;
  const e = (d.elevationDeg * Math.PI) / 180;
  return { origin: cameraOf(w), dir: v3(Math.cos(e) * Math.cos(h), Math.cos(e) * Math.sin(h), Math.sin(e)) };
}

export type LocateResult =
  | {
      status: "OK"; position: Vec3; method: "surface" | "triangulated" | "ray_to_fixture"; confidence: number; residualM: number | null;
      /** How many detections agree on this position (from how many distinct sweeps). */
      support?: { detections: number; sweeps: number };
    }
  | { status: "INSUFFICIENT"; reason: string };

const CLUSTER_M = 1;

/**
 * Estimate where an item is from one or more detections, best method first:
 * 1. `surface` — each ray hits the scan mesh; hits that agree (within 1 m) are clustered and the best-supported
 *    cluster wins, so a false positive in one photo cannot outvote two photos that agree.
 * 2. `triangulated` — ≥ 2 sweeps whose rays meet at a useful angle (no mesh needed).
 * 3. `ray_to_fixture` — the first shelf/fixture box (0–2.5 m tall) a ray hits.
 */
export function locateFromDetections(waypoints: Waypoint[], detections: Detection[], obstacles: Obstacle[] = [], surfaces?: Surfaces): LocateResult {
  const byId = new Map(waypoints.map((w) => [w.id, w]));
  const located = detections
    .map((d) => { const w = byId.get(d.sweepId); const ray = w ? detectionRay(w, d) : null; return ray ? { d, ray } : null; })
    .filter((x): x is { d: Detection; ray: Ray } => !!x);
  const rays = located.map((x) => x.ray);
  if (!rays.length) return { status: "INSUFFICIENT", reason: "No detection referenced a known sweep with orientation data." };

  if (surfaces?.length) {
    const best = surfaceClusters(waypoints, detections, surfaces)[0];
    if (best) {
      return { status: "OK", position: best.position, method: "surface", confidence: best.confidence, residualM: null, support: { detections: best.members.length, sweeps: best.sweeps } };
    }
  }

  const fromDistinctSweeps = new Set(detections.filter((d) => byId.has(d.sweepId)).map((d) => d.sweepId)).size >= 2;
  const tri = fromDistinctSweeps ? triangulate(rays) : null;
  if (tri && tri.spreadDeg >= 8) {
    // In front of every camera? A point behind a camera means the detections disagree.
    const inFront = rays.every((r) => (tri.point.x - r.origin.x) * r.dir.x + (tri.point.y - r.origin.y) * r.dir.y + (tri.point.z - r.origin.z) * r.dir.z > 0);
    if (inFront && tri.residualM < 0.75) {
      const confidence = Math.max(0, Math.min(1, (1 - tri.residualM / 0.75) * Math.min(1, tri.spreadDeg / 30)));
      return { status: "OK", position: tri.point, method: "triangulated", confidence: round(confidence, 2), residualM: round(tri.residualM, 3) };
    }
  }

  // Single-view fallback: the item sits on the first fixture the ray hits.
  let best: { t: number; ray: Ray } | null = null;
  for (const ray of rays) {
    for (const o of obstacles) {
      if (o.kind !== "box") continue;
      const t = rayHitsBox(ray, o, 0, 2.5);
      if (t !== null && t > 0.2 && (!best || t < best.t)) best = { t, ray };
    }
  }
  if (best) {
    const p = add(best.ray.origin, scale(best.ray.dir, best.t));
    return { status: "OK", position: p, method: "ray_to_fixture", confidence: 0.5, residualM: null };
  }
  return {
    status: "INSUFFICIENT",
    reason: fromDistinctSweeps
      ? "The detections do not agree on one position, and no shelf or fixture lies along them."
      : "One view gives a direction but not a distance: add a detection from a second sweep, or shelf boxes.",
  };
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

export interface SurfaceCluster<D extends Detection = Detection> {
  position: Vec3;
  /** Distinct sweeps that saw it here. */
  sweeps: number;
  members: { detection: D; point: Vec3; rangeM: number }[];
  confidence: number;
  score: number;
}

/**
 * Every detection ray cast onto the scan mesh, grouped into places (hits within 1 m of each other). Sorted best
 * first: more distinct sweeps agreeing beats more confident single views. Each detection belongs to one place.
 */
export function surfaceClusters<D extends Detection>(waypoints: Waypoint[], detections: D[], surfaces: Surfaces): SurfaceCluster<D>[] {
  const byId = new Map(waypoints.map((w) => [w.id, w]));
  const hits = detections.flatMap((detection) => {
    const w = byId.get(detection.sweepId);
    const ray = w ? detectionRay(w, detection) : null;
    const t = ray ? raycast(surfaces, ray) : null;
    return ray && t !== null ? [{ detection, point: add(ray.origin, scale(ray.dir, t)), rangeM: t }] : [];
  });
  const weight = (h: (typeof hits)[number]) => h.detection.confidence ?? 1;
  const near = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= CLUSTER_M;
  const clusters: SurfaceCluster<D>[] = [];
  let left = hits;
  while (left.length) {
    // Greedy: the seed whose neighbourhood is best supported becomes a place; its members are removed.
    let best: typeof hits = [];
    let bestScore = -1;
    for (const seed of left) {
      const members = left.filter((h) => near(h.point, seed.point));
      const score = new Set(members.map((m) => m.detection.sweepId)).size * 10 + members.reduce((sum, m) => sum + weight(m), 0);
      if (score > bestScore) { bestScore = score; best = members; }
    }
    const total = best.reduce((sum, m) => sum + weight(m), 0) || best.length;
    const avg = (k: "x" | "y" | "z") => best.reduce((sum, m) => sum + m.point[k] * (weight(m) || 1), 0) / total;
    const sweeps = new Set(best.map((m) => m.detection.sweepId)).size;
    const meanW = best.reduce((sum, m) => sum + weight(m), 0) / best.length;
    clusters.push({
      position: v3(avg("x"), avg("y"), avg("z")), sweeps, members: best,
      confidence: round(Math.min(1, (sweeps >= 2 ? 0.75 : 0.55) * meanW + 0.1 * (sweeps - 1)), 2), score: bestScore,
    });
    left = left.filter((h) => !best.includes(h));
  }
  return clusters.sort((a, b) => b.score - a.score);
}
