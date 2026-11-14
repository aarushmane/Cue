// Digital twin → draft walkable graph (CoStar track).
//
// A Matterport "sweep" is a spot where the scanner stood. The scanner can only stand on walkable floor,
// so sweeps are natural walkable nodes, and sweeps the scanner moved between are natural edges.
// The output is always a DRAFT: staff confirm it in the map editor before it is published.
//
// Pure function. The Matterport adapter (lib/costar) is responsible for converting the API's coordinates
// into floor-plane meters (x to the right, y downward on the floor plan image).

import type { MapEdge, MapNode } from "../types";

export interface TwinSweep {
  id: string;
  x: number; // meters on the floor plane
  y: number; // meters on the floor plane (downward on the plan image)
  floorId: string;
  neighbors?: string[]; // sweep ids the scanner connected, when the API exposes them
  label?: string;
}

/** Axis-aligned obstacle in floor meters (e.g. a shelf footprint) that edges must not cross. */
export interface Obstacle {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A wall as a line segment in floor meters (Matterport's wall graph). */
export interface WallSegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export interface SweepsToGraphOptions {
  floorId: string;
  /** Walls on this floor. Used only for proximity-inferred edges: Matterport's own neighbor links are trusted,
   *  since they already route through doorways (and the wall graph does not mark door gaps reliably). */
  walls?: WallSegment[];
  /** Used only when sweeps carry no neighbor lists: connect sweeps closer than this. */
  maxEdgeM?: number;
  /** Used only when sweeps carry no neighbor lists: keep at most this many nearest neighbors per sweep. */
  maxNeighbors?: number;
  obstacles?: Obstacle[];
  /** Sweep id nearest the entrance, so it becomes the entrance node. */
  entranceSweepId?: string;
  paddingRatio?: number;
  idPrefix?: string;
}

export interface DraftGraph {
  widthM: number;
  heightM: number;
  /** Floor meters → normalized: nx = (x - originX) / widthM, ny = (y - originY) / heightM */
  originX: number;
  originY: number;
  nodes: MapNode[];
  edges: MapEdge[];
  edgeSource: "neighbors" | "proximity";
  components: string[][]; // connected components (node ids); >1 means staff must connect them
  warnings: string[];
}

function segmentHitsRect(ax: number, ay: number, bx: number, by: number, r: Obstacle): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - r.x, r.x + r.w - ax, ay - r.y, r.y + r.h - ay];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

/** True when segments AB and CD properly cross (touching at an endpoint does not count). */
export function segmentsCross(ax: number, ay: number, bx: number, by: number, w: WallSegment): boolean {
  const orient = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = orient(w.ax, w.ay, w.bx, w.by, ax, ay);
  const d2 = orient(w.ax, w.ay, w.bx, w.by, bx, by);
  const d3 = orient(ax, ay, bx, by, w.ax, w.ay);
  const d4 = orient(ax, ay, bx, by, w.bx, w.by);
  const eps = 1e-9;
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
}

function components(ids: string[], edges: MapEdge[]): string[][] {
  const adj = new Map(ids.map((id) => [id, [] as string[]]));
  for (const e of edges) {
    adj.get(e.from)?.push(e.to);
    adj.get(e.to)?.push(e.from);
  }
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const comp: string[] = [];
    const stack = [id];
    seen.add(id);
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const n of adj.get(cur) ?? []) {
        if (seen.has(n)) continue;
        seen.add(n);
        stack.push(n);
      }
    }
    out.push(comp.sort());
  }
  return out.sort((a, b) => b.length - a.length);
}

export function sweepsToGraph(sweeps: TwinSweep[], opts: SweepsToGraphOptions): DraftGraph {
  const {
    floorId, maxEdgeM = 4, maxNeighbors = 4, obstacles = [], walls = [], entranceSweepId, paddingRatio = 0.05, idPrefix = "T",
  } = opts;
  const warnings: string[] = [];
  const floor = sweeps.filter((s) => s.floorId === floorId);
  if (floor.length === 0) {
    return { widthM: 0, heightM: 0, originX: 0, originY: 0, nodes: [], edges: [], edgeSource: "proximity", components: [], warnings: [`No sweeps on floor ${floorId}.`] };
  }

  // Normalize into a padded bounding box so nodes sit inside 0..1.
  const xs = floor.map((s) => s.x);
  const ys = floor.map((s) => s.y);
  const spanX = Math.max(Math.max(...xs) - Math.min(...xs), 1);
  const spanY = Math.max(Math.max(...ys) - Math.min(...ys), 1);
  const padX = spanX * paddingRatio;
  const padY = spanY * paddingRatio;
  const originX = Math.min(...xs) - padX;
  const originY = Math.min(...ys) - padY;
  const widthM = spanX + 2 * padX;
  const heightM = spanY + 2 * padY;

  const idFor = new Map(floor.map((s, i) => [s.id, `${idPrefix}${String(i + 1).padStart(2, "0")}`]));
  const byId = new Map(floor.map((s) => [s.id, s]));
  const nodes: MapNode[] = floor.map((s, i) => ({
    id: idFor.get(s.id)!,
    x: (s.x - originX) / widthM,
    y: (s.y - originY) / heightM,
    kind: s.id === entranceSweepId ? "entrance" : "junction",
    label: s.label ?? (s.id === entranceSweepId ? "the entrance" : `scan point ${i + 1}`),
    source: "matterport",
    sweepId: s.id,
  }));

  const dist = (a: TwinSweep, b: TwinSweep) => Math.hypot(a.x - b.x, a.y - b.y);
  const hasNeighbors = floor.some((s) => s.neighbors && s.neighbors.length > 0);
  const blocked = (a: TwinSweep, b: TwinSweep) =>
    obstacles.some((o) => segmentHitsRect(a.x, a.y, b.x, b.y, o)) ||
    (!hasNeighbors && walls.some((w) => segmentsCross(a.x, a.y, b.x, b.y, w)));

  const pairs = new Map<string, [TwinSweep, TwinSweep]>();
  const addPair = (a: TwinSweep, b: TwinSweep) => {
    if (a.id === b.id) return;
    const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    if (!pairs.has(key)) pairs.set(key, a.id < b.id ? [a, b] : [b, a]);
  };

  if (hasNeighbors) {
    for (const s of floor) for (const n of s.neighbors ?? []) {
      const other = byId.get(n);
      if (other) addPair(s, other); // neighbors on other floors are dropped (stairs/elevators come later)
    }
  } else {
    warnings.push(`Sweeps have no neighbor data; edges inferred from proximity (≤ ${maxEdgeM} m, ${maxNeighbors} nearest${walls.length ? ", not through walls" : ""}). Staff must verify.`);
    // Pick nearest neighbors among those not blocked, so a wall doesn't use up a sweep's neighbor slots.
    for (const s of floor) {
      floor
        .filter((o) => o.id !== s.id && dist(s, o) <= maxEdgeM && !blocked(s, o))
        .sort((a, b) => dist(s, a) - dist(s, b))
        .slice(0, maxNeighbors)
        .forEach((o) => addPair(s, o));
    }
  }

  const edges: MapEdge[] = [];
  let droppedByObstacle = 0;
  for (const [a, b] of pairs.values()) {
    if (blocked(a, b)) {
      droppedByObstacle++;
      continue;
    }
    // Round weights UP so they never undercut straight-line distance (keeps A*'s heuristic admissible).
    edges.push({ id: `${idPrefix}E${String(edges.length + 1).padStart(3, "0")}`, from: idFor.get(a.id)!, to: idFor.get(b.id)!, weight: Math.ceil(dist(a, b) * 10) / 10 });
  }
  if (droppedByObstacle) warnings.push(`${droppedByObstacle} candidate edge(s) dropped because they cross a shelf or wall.`);
  if (hasNeighbors && floor.some((s) => !s.neighbors?.length)) warnings.push(`${floor.filter((s) => !s.neighbors?.length).length} scan point(s) have no neighbor links; connect them in the map editor.`);

  const comps = components(nodes.map((n) => n.id), edges);
  if (comps.length > 1) warnings.push(`Graph has ${comps.length} disconnected parts; connect them in the map editor before publishing.`);
  if (!entranceSweepId) warnings.push("No entrance chosen; mark the entrance node before publishing.");

  return { widthM, heightM, originX, originY, nodes, edges, edgeSource: hasNeighbors ? "neighbors" : "proximity", components: comps, warnings };
}
