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

export interface GraphBridge {
  edgeId: string;
  from: string; // node id
  to: string; // node id
  lengthM: number;
}

/** Shape-of-the-graph report so staff (and tests) can judge how trustworthy a draft is. */
export interface GraphMetrics {
  /** Edge lengths (straight-line meters) in 1 m bins: [fromM, toM). Includes bridges. */
  edgeLengthHistogram: { fromM: number; toM: number; count: number }[];
  /** How many nodes have each degree, ascending by degree. Degree 0 = isolated scan point. */
  degreeDistribution: { degree: number; count: number }[];
  /** Connected components before bridging (equal to components.length when nothing was bridged). */
  componentsBeforeBridging: number;
  /** Final component count and sizes (largest first). */
  components: number;
  componentSizes: number[];
  /** Candidate proximity edges (≤ maxEdgeM) rejected because they cross a wall. Always 0 when neighbors are used. */
  edgesDroppedByWalls: number;
  /** Edges added between components (proximity mode only); each is also listed in warnings. */
  bridges: GraphBridge[];
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
  metrics: GraphMetrics;
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

const HIST_BIN_M = 1;

function lengthHistogram(lengths: number[]): GraphMetrics["edgeLengthHistogram"] {
  if (lengths.length === 0) return [];
  const bins = Math.floor(Math.max(...lengths) / HIST_BIN_M) + 1;
  const out = Array.from({ length: bins }, (_, i) => ({ fromM: i * HIST_BIN_M, toM: (i + 1) * HIST_BIN_M, count: 0 }));
  for (const l of lengths) out[Math.floor(l / HIST_BIN_M)].count++;
  return out;
}

function degreeDistribution(ids: string[], edges: MapEdge[]): GraphMetrics["degreeDistribution"] {
  const deg = new Map(ids.map((id) => [id, 0]));
  for (const e of edges) {
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
    deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
  }
  const counts = new Map<number, number>();
  for (const d of deg.values()) counts.set(d, (counts.get(d) ?? 0) + 1);
  return [...counts].map(([degree, count]) => ({ degree, count })).sort((a, b) => a.degree - b.degree);
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
    const metrics: GraphMetrics = {
      edgeLengthHistogram: [], degreeDistribution: [], componentsBeforeBridging: 0, components: 0, componentSizes: [], edgesDroppedByWalls: 0, bridges: [],
    };
    return { widthM: 0, heightM: 0, originX: 0, originY: 0, nodes: [], edges: [], edgeSource: "proximity", components: [], warnings: [`No sweeps on floor ${floorId}.`], metrics };
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
  const crossesWall = (a: TwinSweep, b: TwinSweep) => walls.some((w) => segmentsCross(a.x, a.y, b.x, b.y, w));
  const blocked = (a: TwinSweep, b: TwinSweep) =>
    obstacles.some((o) => segmentHitsRect(a.x, a.y, b.x, b.y, o)) || (!hasNeighbors && crossesWall(a, b));

  const pairs = new Map<string, [TwinSweep, TwinSweep]>();
  const addPair = (a: TwinSweep, b: TwinSweep) => {
    if (a.id === b.id) return;
    const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    if (!pairs.has(key)) pairs.set(key, a.id < b.id ? [a, b] : [b, a]);
  };

  let edgesDroppedByWalls = 0;
  if (hasNeighbors) {
    for (const s of floor) for (const n of s.neighbors ?? []) {
      const other = byId.get(n);
      if (other) addPair(s, other); // neighbors on other floors are dropped (stairs/elevators come later)
    }
  } else {
    warnings.push(`Sweeps have no neighbor data; edges inferred from proximity (≤ ${maxEdgeM} m, ${maxNeighbors} nearest${walls.length ? ", not through walls" : ""}). Staff must verify.`);
    // Count each in-range pair rejected by a wall once (for the metric report).
    if (walls.length) {
      for (let i = 0; i < floor.length; i++) for (let j = i + 1; j < floor.length; j++) {
        if (dist(floor[i], floor[j]) <= maxEdgeM && crossesWall(floor[i], floor[j])) edgesDroppedByWalls++;
      }
    }
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
  const edgeLengths: number[] = [];
  const pushEdge = (a: TwinSweep, b: TwinSweep): MapEdge => {
    // Round weights UP so they never undercut straight-line distance (keeps A*'s heuristic admissible).
    const e = { id: `${idPrefix}E${String(edges.length + 1).padStart(3, "0")}`, from: idFor.get(a.id)!, to: idFor.get(b.id)!, weight: Math.ceil(dist(a, b) * 10) / 10 };
    edges.push(e);
    edgeLengths.push(dist(a, b));
    return e;
  };
  let droppedByObstacle = 0;
  for (const [a, b] of pairs.values()) {
    if (blocked(a, b)) {
      droppedByObstacle++;
      continue;
    }
    pushEdge(a, b);
  }
  if (droppedByObstacle) warnings.push(`${droppedByObstacle} candidate edge(s) dropped because they cross a shelf or wall.`);
  if (hasNeighbors && floor.some((s) => !s.neighbors?.length)) warnings.push(`${floor.filter((s) => !s.neighbors?.length).length} scan point(s) have no neighbor links; connect them in the map editor.`);

  const nodeIds = nodes.map((n) => n.id);
  let comps = components(nodeIds, edges);
  const componentsBeforeBridging = comps.length;
  const bridges: GraphBridge[] = [];

  // Bridging (proximity mode only; Matterport's own links are left alone). Kruskal-style: repeatedly join the
  // closest pair of sweeps in different components, as long as that pair is under 2×maxEdgeM and crosses no wall
  // or obstacle. Typical case: a doorway wider than the sweep spacing, where the nearest sweeps either side are
  // just beyond maxEdgeM. Every bridge is surfaced as a warning so staff confirm it is a real walkway.
  if (!hasNeighbors && comps.length > 1) {
    const compOf = new Map<string, number>();
    comps.forEach((c, i) => c.forEach((id) => compOf.set(id, i)));
    const sweepComp = (s: TwinSweep) => compOf.get(idFor.get(s.id)!)!;
    const limit = 2 * maxEdgeM;
    const candidates: [TwinSweep, TwinSweep, number][] = [];
    for (let i = 0; i < floor.length; i++) for (let j = i + 1; j < floor.length; j++) {
      const a = floor[i];
      const b = floor[j];
      if (sweepComp(a) === sweepComp(b)) continue;
      const d = dist(a, b);
      if (d < limit) candidates.push([a, b, d]);
    }
    candidates.sort((p, q) => p[2] - q[2]);

    const parent = comps.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    let remaining = comps.length;
    for (const [a, b, d] of candidates) {
      if (remaining === 1) break;
      const ra = find(sweepComp(a));
      const rb = find(sweepComp(b));
      if (ra === rb || blocked(a, b)) continue;
      parent[ra] = rb;
      remaining--;
      const e = pushEdge(a, b);
      bridges.push({ edgeId: e.id, from: e.from, to: e.to, lengthM: Math.round(d * 10) / 10 });
      const na = nodes.find((n) => n.id === e.from)!;
      const nb = nodes.find((n) => n.id === e.to)!;
      warnings.push(
        `Bridge ${e.id}: joined ${na.label} (${e.from}) and ${nb.label} (${e.to}) across ${Math.round(d * 10) / 10} m to connect separate parts of the scan; check it is a real walkway (e.g. a doorway).`,
      );
    }
    if (bridges.length) comps = components(nodeIds, edges);
  }

  if (comps.length > 1) warnings.push(`Graph has ${comps.length} disconnected parts; connect them in the map editor before publishing.`);
  if (!entranceSweepId) warnings.push("No entrance chosen; mark the entrance node before publishing.");

  const metrics: GraphMetrics = {
    edgeLengthHistogram: lengthHistogram(edgeLengths),
    degreeDistribution: degreeDistribution(nodeIds, edges),
    componentsBeforeBridging,
    components: comps.length,
    componentSizes: comps.map((c) => c.length),
    edgesDroppedByWalls,
    bridges,
  };

  return { widthM, heightM, originX, originY, nodes, edges, edgeSource: hasNeighbors ? "neighbors" : "proximity", components: comps, warnings, metrics };
}
