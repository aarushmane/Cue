// Matterport Model API (GraphQL) for the CoStar track. Server-only.
// Auth: HTTP basic, MATTERPORT_API_KEY = user, MATTERPORT_API_TOKEN = password. Production host only.
// Reference: the track quickstart (beta-app.matterport.com/2026-princeton-hackathon/quickstart) and AGENTS.md.
//
// Frames: Matterport positions are meters in the model frame, x right, y up (z = height). Our floor-plan frame is
// y DOWN (like an image), so every y is negated here, in one place. The frame is not north-aligned.
import type { TwinSweep, WallSegment } from "../twin/sweepsToGraph";
import type { FloorPlanImage, TwinModel } from "./types";

const API = "https://api.matterport.com/api/models/graph";

export class MatterportError extends Error {}

export function matterportConfigured(): boolean {
  return Boolean(process.env.MATTERPORT_API_KEY && process.env.MATTERPORT_API_TOKEN);
}

export async function graph<T = Record<string, unknown>>(query: string, variables: Record<string, unknown>): Promise<T> {
  const auth = Buffer.from(`${process.env.MATTERPORT_API_KEY}:${process.env.MATTERPORT_API_TOKEN}`).toString("base64");
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 401 || res.status === 403) throw new MatterportError(`Matterport rejected the key (HTTP ${res.status}). Check MATTERPORT_API_KEY / MATTERPORT_API_TOKEN.`);
  if (!res.ok) throw new MatterportError(`Matterport API HTTP ${res.status}`);
  const body = (await res.json()) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
  const err = body.errors?.[0];
  if (err) {
    if (err.extensions?.code === "not.found") throw new MatterportError("not.found");
    throw new MatterportError(`GraphQL error: ${err.message}`);
  }
  return body.data as T;
}

// ───────────────────────────── Queries ─────────────────────────────

export const Q_BASICS = `query Basics($id: ID!) { model(id: $id) {
  id name internalId
  address { address locality administrativeArea postalCode }
  geolocation { lat long }
  propertyClassifications { classification type }
} }`;

const FLOORS_AND_PLANS = `
  floors { id label vertices { id position { x y } } edges { id type vertices { id } } }
  assets { floorplans(provider: "matterport") { format flags url width height resolution origin { x y } } }`;

/** Preferred: anchor locations carry Matterport's navigation neighbors, floor and room. */
export const Q_TWIN_LOCATIONS = `query Twin($id: ID!) { model(id: $id) {${FLOORS_AND_PLANS}
  locations { id position { x y z } neighbors floor { id } room { id classifications { label } }
              pano { id label skybox(resolution: "2k") { children } } }
} }`;

/** Fallback when `locations` is unavailable: pano positions only (edges then come from proximity + walls). */
export const Q_TWIN_PANOS = `query TwinPanos($id: ID!) { model(id: $id) {${FLOORS_AND_PLANS}
  panoLocations { id label position { x y z } skybox(resolution: "2k") { children } }
} }`;

// ───────────────────────────── Response shapes (null fields are omitted, so everything is optional) ──────

interface Pt { x?: number; y?: number; z?: number }
interface RawFloor { id: string; label?: string; vertices?: { id: string; position?: Pt }[]; edges?: { id: string; type?: string; vertices?: { id: string }[] }[] }
interface RawPlan { format?: string; flags?: string[]; url?: string; width?: number; height?: number; resolution?: number; origin?: Pt }
interface RawSkybox { children?: string[] }
export interface RawTwin {
  floors?: RawFloor[];
  assets?: { floorplans?: RawPlan[] };
  locations?: {
    id: string;
    position?: Pt;
    neighbors?: string[];
    floor?: { id: string };
    room?: { id: string; classifications?: { label?: string }[] };
    pano?: { id: string; label?: string; skybox?: RawSkybox };
  }[];
  panoLocations?: { id: string; label?: string; position?: Pt; skybox?: RawSkybox }[];
}

// ───────────────────────────── Pure mapping (unit-tested) ─────────────────────────────

/** Skybox faces are ordered up, four horizon faces, down. Face 1 (first horizon face) makes the best reference photo. */
const horizonFace = (s?: RawSkybox) => s?.children?.[1] ?? s?.children?.[0] ?? null;

function wallsOf(f: RawFloor): WallSegment[] {
  const v = new Map((f.vertices ?? []).map((x) => [x.id, x.position ?? {}]));
  return (f.edges ?? []).flatMap((e) => {
    if (e.type && e.type !== "wall") return []; // doors/openings are passable
    const [a, b] = (e.vertices ?? []).map((x) => v.get(x.id));
    if (!a || !b || a.x == null || a.y == null || b.x == null || b.y == null) return [];
    return [{ ax: a.x, ay: -a.y, bx: b.x, by: -b.y }];
  });
}

/** Assign floor ids by height when the API gives no floor per pano: sort by z, split where z jumps > 1.5 m. */
function floorsByHeight(zs: number[], floorIds: string[]): string[] {
  if (floorIds.length <= 1) return zs.map(() => floorIds[0] ?? "floor-1");
  const order = zs.map((z, i) => [z, i] as const).sort((a, b) => a[0] - b[0]);
  const out: string[] = new Array(zs.length);
  let level = 0;
  for (let k = 0; k < order.length; k++) {
    if (k > 0 && order[k][0] - order[k - 1][0] > 1.5) level = Math.min(level + 1, floorIds.length - 1);
    out[order[k][1]] = floorIds[level];
  }
  return out;
}

export function mapTwin(modelId: string, raw: RawTwin): TwinModel {
  const floors = (raw.floors ?? []).map((f, i) => ({ id: f.id, label: f.label || `Floor ${i + 1}` }));
  const walls = Object.fromEntries((raw.floors ?? []).map((f) => [f.id, wallsOf(f)]));
  const sweeps: TwinSweep[] = [];
  const panoramas: TwinModel["panoramas"] = [];
  const rooms: Record<string, string> = {};

  const locs = (raw.locations ?? []).filter((l) => l.position?.x != null && l.position?.y != null);
  if (locs.length > 0) {
    const ids = new Set(locs.map((l) => l.id));
    const fallbackFloors = floorsByHeight(locs.map((l) => l.position!.z ?? 0), floors.map((f) => f.id));
    locs.forEach((l, i) => {
      const room = l.room?.classifications?.[0]?.label;
      if (room) rooms[l.id] = room;
      sweeps.push({
        id: l.id,
        x: l.position!.x!,
        y: -l.position!.y!,
        floorId: l.floor?.id ?? fallbackFloors[i],
        neighbors: (l.neighbors ?? []).filter((n) => ids.has(n)),
        label: room ? `the ${room.toLowerCase()}` : undefined,
      });
      const face = horizonFace(l.pano?.skybox);
      if (face) panoramas.push({ sweepId: l.id, imageUrl: face });
    });
  } else {
    const panos = (raw.panoLocations ?? []).filter((p) => p.position?.x != null && p.position?.y != null);
    const fl = floorsByHeight(panos.map((p) => p.position!.z ?? 0), floors.map((f) => f.id));
    panos.forEach((p, i) => {
      sweeps.push({ id: p.id, x: p.position!.x!, y: -p.position!.y!, floorId: fl[i] });
      const face = horizonFace(p.skybox);
      if (face) panoramas.push({ sweepId: p.id, imageUrl: face });
    });
  }
  if (floors.length === 0 && sweeps.length) floors.push({ id: sweeps[0].floorId, label: "Floor 1" });

  const floorPlans: FloorPlanImage[] = (raw.assets?.floorplans ?? [])
    .filter((p) => p.format === "jpg" && p.url && (p.flags ?? []).join() === "photogramy" && p.resolution && p.origin)
    .map((p) => ({ url: p.url!, width: p.width ?? 0, height: p.height ?? 0, resolution: p.resolution!, originX: p.origin!.x ?? 0, originY: p.origin!.y ?? 0 }));

  return { modelId, floors, sweeps, panoramas, floorPlanImageUrl: floorPlans[0]?.url ?? null, floorPlans, walls, rooms };
}

export async function fetchTwin(modelId: string): Promise<TwinModel | null> {
  try {
    let raw = (await graph<{ model: RawTwin | null }>(Q_TWIN_LOCATIONS, { id: modelId })).model;
    if (!raw?.locations?.length) raw = (await graph<{ model: RawTwin | null }>(Q_TWIN_PANOS, { id: modelId })).model;
    return raw ? mapTwin(modelId, raw) : null;
  } catch (err) {
    if (err instanceof MatterportError && err.message === "not.found") return null;
    if (err instanceof MatterportError && err.message.startsWith("GraphQL error")) {
      // The key may not expose `locations`; retry with pano positions only.
      const raw = (await graph<{ model: RawTwin | null }>(Q_TWIN_PANOS, { id: modelId })).model;
      return raw ? mapTwin(modelId, raw) : null;
    }
    throw err;
  }
}
