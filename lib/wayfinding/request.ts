// Request parsing shared by the wayfinding API routes. Server only.
import "server-only";
import { z } from "zod";
import { getDb } from "../db/client";
import { isDemoScene } from "../scenes/demo";
import { loadScene, ObstacleInput, SceneItemInput } from "./scene";
import type { StartPoint, Waypoint, WayfindingScene } from "./types";

const Vec3 = z.object({ x: z.number(), y: z.number(), z: z.number() });

const Detection = z.union([
  z.object({ sweep_id: z.string(), face: z.number().int().min(0).max(5), u: z.number().min(0).max(1), v: z.number().min(0).max(1) })
    .transform((d) => ({ sweepId: d.sweep_id, face: d.face, u: d.u, v: d.v })),
  z.object({ sweep_id: z.string(), heading_deg: z.number(), elevation_deg: z.number().min(-90).max(90) })
    .transform((d) => ({ sweepId: d.sweep_id, headingDeg: d.heading_deg, elevationDeg: d.elevation_deg })),
]);

export const WayfindingBody = z.object({
  model_id: z.string().regex(/^[a-zA-Z0-9]{11}$/),
  query: z.string().min(1).max(300).optional(),
  item_id: z.string().max(100).optional(),
  /**
   * Where the visitor is: the current Showcase sweep and/or a model-frame position (the sweep wins when it is a
   * known scan point). Omit it to start from the tour's first scan point.
   */
  start: z.object({ sweep_id: z.string().min(1).max(64).optional(), position: Vec3.optional(), floor_id: z.string().nullish() }).default({}),
  /**
   * Optional scan points from the Showcase SDK (`Sweep.data`, positions converted to the Model API frame with
   * `puckPosition` as the floor point). Showcase often exposes more sweeps than the Model API; these are merged in
   * by id, keeping the API's orientation data where it exists.
   */
  waypoints: z.array(z.object({
    id: z.string().min(1).max(64),
    position: Vec3,
    floor_id: z.string().nullish(),
    neighbors: z.array(z.string().max(64)).max(64).default([]),
  })).max(5000).default([]),
  /** Optional inputs merged over data/wayfinding/<model_id>.json for this request. */
  items: z.array(SceneItemInput).max(2000).default([]),
  obstacles: z.array(ObstacleInput).max(2000).default([]),
  detections: z.array(z.object({ label: z.string().min(1).max(200), detections: z.array(Detection).min(1).max(20) })).max(20).default([]),
  options: z.object({
    clearance_m: z.number().min(0).max(2).optional(),
    max_approach_m: z.number().min(0.5).max(30).optional(),
    arrow_spacing_m: z.number().min(0.2).max(5).optional(),
    smooth: z.boolean().optional(),
  }).default({}),
});
export type WayfindingBody = z.infer<typeof WayfindingBody>;

export function toStart(s: WayfindingBody["start"], scene: WayfindingScene): StartPoint {
  if (s.sweep_id && scene.waypoints.some((w) => w.id === s.sweep_id)) return { sweepId: s.sweep_id };
  if (s.position) {
    // Standing on a scan or aisle point (e.g. where "walk me there" stopped): plan from that point, so the route
    // agrees with where the visitor was just sent.
    const p = s.position;
    const on = scene.waypoints.find((w) => Math.hypot(w.position.x - p.x, w.position.y - p.y) < 0.35);
    if (on) return { sweepId: on.id };
    return { position: s.position, floorId: s.floor_id ?? null };
  }
  if (s.sweep_id) return { sweepId: s.sweep_id }; // unknown id: the planner reports START_INVALID
  // Matterport labels scan points in capture order; "0" is where the scan (and the default tour) starts.
  const first = [...scene.waypoints].sort((a, b) => (Number(a.label) || 0) - (Number(b.label) || 0))[0];
  return { sweepId: first?.id ?? "" };
}

export const toOptions = (o: WayfindingBody["options"]) => ({
  clearanceM: o.clearance_m, maxApproachM: o.max_approach_m, arrowSpacingM: o.arrow_spacing_m, smooth: o.smooth,
});

/** Only scans registered to a property are served (same rule as the tour pages). */
export async function assertRegistered(modelId: string) {
  if (isDemoScene(modelId)) return;
  const registered = await getDb("read").from("stores").select("id").eq("matterport_model_id", modelId).limit(1);
  if (registered.error) throw new HttpError(503, "Could not look up the saved scene.");
  if (!registered.data?.length) throw new HttpError(404, "Add this model to a property before routing in it.");
}

export async function sceneFor(body: WayfindingBody) {
  await assertRegistered(body.model_id);
  try {
    const scene = await loadScene(body.model_id, { items: body.items, obstacles: body.obstacles });
    return body.waypoints.length ? { ...scene, waypoints: mergeWaypoints(scene.waypoints, body.waypoints) } : scene;
  } catch (error) {
    throw new HttpError(502, error instanceof Error ? error.message : "Could not load the space.");
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function errorResponse(error: unknown) {
  if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
  console.error("wayfinding failed", error);
  return Response.json({ error: "Wayfinding failed. Try again." }, { status: 500 });
}

/** Client sweeps (complete graph) take over positions and links; API sweeps keep their camera and orientation. */
export function mergeWaypoints(api: Waypoint[], client: WayfindingBody["waypoints"]): Waypoint[] {
  const known = new Map(api.map((w) => [w.id, w]));
  const ids = new Set(client.map((c) => c.id));
  const merged: Waypoint[] = client.map((c) => {
    const base = known.get(c.id);
    return {
      id: c.id,
      position: c.position,
      camera: base?.camera,
      rotation: base?.rotation,
      floorId: c.floor_id ?? base?.floorId ?? null,
      neighbors: c.neighbors.filter((n) => ids.has(n) && n !== c.id),
      label: base?.label,
    };
  });
  // API-only sweeps (not reported by the SDK) stay, with links limited to sweeps that still exist.
  for (const w of api) if (!ids.has(w.id)) merged.push({ ...w, neighbors: w.neighbors.filter((n) => ids.has(n) || known.has(n)) });
  return merged;
}
