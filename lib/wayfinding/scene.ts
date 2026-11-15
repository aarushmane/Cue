// Loads a WayfindingScene for a Matterport model. Server only.
//
// - Scan points (3D positions, orientation, neighbours, floor) and walls come from the Matterport Model API.
// - Items and obstacles (shelf boxes) come from `data/wayfinding/<modelId>.json` when present, plus anything the
//   caller passes in the request. Those inputs are supplied later by staff, inventory or a vision pass.
import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { graph, matterportConfigured } from "../costar/matterport";
import { parseObj, type Surfaces } from "./mesh";
import { withAislePoints, type WalkGrid } from "./walkable";
import type { Obstacle, SceneItem, Waypoint, WayfindingScene } from "./types";

const Vec3 = z.object({ x: z.number(), y: z.number(), z: z.number() });

export const SceneItemInput = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  aliases: z.array(z.string().max(200)).max(20).optional(),
  brand: z.string().max(200).nullish(),
  category: z.string().max(200).nullish(),
  position: Vec3,
  floorId: z.string().nullish(),
  source: z.enum(["staff", "inventory", "vision"]).default("staff"),
  confidence: z.number().min(0).max(1).optional(),
});

export const ObstacleInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("box"), id: z.string().optional(), label: z.string().optional(), minX: z.number(), minY: z.number(), maxX: z.number(), maxY: z.number(), floorId: z.string().nullish() }),
  z.object({ kind: z.literal("wall"), id: z.string().optional(), ax: z.number(), ay: z.number(), bx: z.number(), by: z.number(), floorId: z.string().nullish() }),
]);

export const SceneInputs = z.object({
  items: z.array(SceneItemInput).max(2000).default([]),
  obstacles: z.array(ObstacleInput).max(2000).default([]),
});
export type SceneInputs = z.infer<typeof SceneInputs>;

const QUERY = `query Wayfinding($id: ID!) { model(id: $id) {
  floors { id vertices { id position { x y } } edges { id type vertices { id } } }
  panoLocations {
    id label position { x y z } rotation { x y z w }
    anchor { id position { x y z } neighbors floor { id } }
  }
} }`;

type Raw = {
  floors?: { id: string; vertices?: { id: string; position?: { x?: number; y?: number } }[]; edges?: { id: string; type?: string; vertices?: { id: string }[] }[] }[];
  panoLocations?: {
    id: string; label?: string;
    position?: { x: number; y: number; z: number } | null;
    rotation?: { x: number; y: number; z: number; w: number } | null;
    anchor?: { id: string; position?: { x: number; y: number; z: number } | null; neighbors?: string[] | null; floor?: { id: string } | null } | null;
  }[];
};

const finite = (...n: (number | undefined)[]) => n.every((x) => typeof x === "number" && Number.isFinite(x));

/** Pure: Model API response → scan points and walls (model frame; no axis flips). */
export function mapScene(raw: Raw): { waypoints: Waypoint[]; walls: Obstacle[] } {
  const waypoints: Waypoint[] = [];
  for (const p of raw.panoLocations ?? []) {
    const cam = p.position;
    const anchor = p.anchor?.position;
    if (!cam || !finite(cam.x, cam.y, cam.z)) continue;
    // Anchor = floor under the scanner; when missing, assume the usual 1.35 m tripod height.
    const floor = anchor && finite(anchor.x, anchor.y, anchor.z) ? anchor : { x: cam.x, y: cam.y, z: cam.z - 1.35 };
    waypoints.push({
      id: p.id,
      position: { x: floor.x, y: floor.y, z: floor.z },
      camera: { x: cam.x, y: cam.y, z: cam.z },
      rotation: p.rotation ?? undefined,
      floorId: p.anchor?.floor?.id ?? null,
      neighbors: p.anchor?.neighbors ?? [],
      label: p.label,
    });
  }
  const ids = new Set(waypoints.map((w) => w.id));
  for (const w of waypoints) w.neighbors = w.neighbors.filter((n) => ids.has(n) && n !== w.id);

  const walls: Obstacle[] = [];
  for (const f of raw.floors ?? []) {
    const v = new Map((f.vertices ?? []).map((x) => [x.id, x.position ?? {}]));
    for (const e of f.edges ?? []) {
      if (e.type && e.type !== "wall") continue; // doors and openings are passable
      const [a, b] = (e.vertices ?? []).map((x) => v.get(x.id));
      if (a && b && finite(a.x, a.y, b.x, b.y)) walls.push({ kind: "wall", id: e.id, ax: a.x!, ay: a.y!, bx: b.x!, by: b.y!, floorId: f.id });
    }
  }
  return { waypoints, walls };
}

async function storedInputs(modelId: string): Promise<SceneInputs> {
  if (!/^[a-zA-Z0-9]{11}$/.test(modelId)) return { items: [], obstacles: [] };
  try {
    const text = await readFile(path.join(process.cwd(), "data", "wayfinding", `${modelId}.json`), "utf8");
    return SceneInputs.parse(JSON.parse(text));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { items: [], obstacles: [] };
    throw new Error(`data/wayfinding/${modelId}.json is not valid wayfinding input.`);
  }
}

// The surface mesh rarely changes; keep the parsed triangles for an hour.
const meshes = new Map<string, { at: number; value: Promise<Surfaces | undefined> }>();

async function scanMesh(modelId: string): Promise<Surfaces | undefined> {
  const hit = meshes.get(modelId);
  if (hit && Date.now() - hit.at < 60 * 60_000) return hit.value;
  const value = (async () => {
    const d = await graph<{ model: { assets?: { meshes?: { filename?: string; url?: string | null }[] } } | null }>(
      `query Mesh($id: ID!) { model(id: $id) { assets { meshes(formats: "obj") { filename url } } } }`, { id: modelId },
    );
    const list = d.model?.assets?.meshes ?? [];
    const mesh = list.find((m) => m.filename === "out_res_50k.obj") ?? list[0];
    if (!mesh?.url || !new URL(mesh.url).hostname.endsWith(".matterport.com")) return undefined;
    const response = await fetch(mesh.url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) return undefined;
    return parseObj(await response.text());
  })().catch((error: unknown) => { console.warn("wayfinding: scan mesh unavailable", error); return undefined; });
  meshes.set(modelId, { at: Date.now(), value });
  value.then((v) => { if (!v) meshes.delete(modelId); });
  return value;
}

// Signed skybox URLs expire after about five minutes; reuse a lookup for two.
const skyboxes = new Map<string, { at: number; value: Promise<Map<string, string>> }>();

/** Signed skybox face URL templates per scan point (`<face>` → 0–5), fresh enough to fetch right away. */
export function skyboxTemplates(modelId: string): Promise<Map<string, string>> {
  const hit = skyboxes.get(modelId);
  if (hit && Date.now() - hit.at < 2 * 60_000) return hit.value;
  const value = graph<{ model: { panoLocations?: { id: string; high?: { urlTemplate?: string | null } | null }[] } | null }>(
    `query Skyboxes($id: ID!) { model(id: $id) { panoLocations { id high: skybox(resolution: "high") { urlTemplate } } } }`,
    { id: modelId },
  ).then((data) => new Map((data.model?.panoLocations ?? []).flatMap((p) => (p.high?.urlTemplate ? [[p.id, p.high.urlTemplate] as const] : []))));
  skyboxes.set(modelId, { at: Date.now(), value });
  value.catch(() => skyboxes.delete(modelId));
  return value;
}

const cache = new Map<string, { at: number; value: Promise<{ waypoints: Waypoint[]; walls: Obstacle[] }> }>();

async function matterportScene(modelId: string) {
  const hit = cache.get(modelId);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value;
  const value = graph<{ model: Raw | null }>(QUERY, { id: modelId }).then((d) => {
    if (!d.model) throw new Error("This scan is unavailable to the configured Matterport account.");
    return mapScene(d.model);
  });
  cache.set(modelId, { at: Date.now(), value });
  value.catch(() => cache.delete(modelId));
  return value;
}

const graphs = new WeakMap<Surfaces, Map<string, { waypoints: Waypoint[]; walk: WalkGrid }>>();

/** The full scene for planning: Matterport geometry + stored inputs + per-request inputs (request wins on id). */
export async function loadScene(modelId: string, extra: SceneInputs = { items: [], obstacles: [] }): Promise<WayfindingScene> {
  if (!matterportConfigured()) throw new Error("Configure MATTERPORT_API_KEY and MATTERPORT_API_TOKEN.");
  const [{ waypoints, walls }, stored, surfaces] = await Promise.all([matterportScene(modelId), storedInputs(modelId), scanMesh(modelId)]);
  const items = new Map<string, SceneItem>();
  for (const item of [...stored.items, ...extra.items]) items.set(item.id, item as SceneItem);
  let graph: { waypoints: Waypoint[]; walk?: WalkGrid } = { waypoints };
  if (surfaces) {
    const key = waypoints.map((w) => w.id).join(",");
    const perMesh = graphs.get(surfaces) ?? new Map();
    graphs.set(surfaces, perMesh);
    if (!perMesh.has(key)) perMesh.set(key, withAislePoints(waypoints, surfaces));
    graph = perMesh.get(key)!;
  }
  return {
    modelId, waypoints: graph.waypoints, items: [...items.values()],
    obstacles: [...walls, ...stored.obstacles, ...extra.obstacles] as Obstacle[], surfaces, walk: graph.walk,
  };
}
