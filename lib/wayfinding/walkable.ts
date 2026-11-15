// Walkable floor from the scan mesh, and extra standing points ("aisle points") where the scanner never stood.
//
// The mesh is rasterised onto a 10 cm floor grid: a cell is free when floor was scanned there and nothing occupies
// the band between ankle and head height above it (shelves, counters, walls, people). A distance transform gives each
// free cell its clearance to the nearest obstacle. Aisle points are placed about every metre on cells with enough
// clearance, and linked when the straight line between them stays clear. Pure and dependency-free.
import type { Vec3, Waypoint } from "./types";

export interface WalkGrid {
  minX: number;
  minY: number;
  /** Cell size, metres. */
  cell: number;
  nx: number;
  ny: number;
  floorZ: number;
  /** Metres from each cell to the nearest obstacle or unscanned cell (0 = not walkable). Row-major, x fastest. */
  clearance: Float32Array;
}

export interface WalkOptions {
  cell?: number;
  /** Height band above the floor where anything counts as an obstacle. */
  bandMinM?: number;
  bandMaxM?: number;
  /** Only rasterise within this distance of the seeds (scan points). */
  radiusM?: number;
}

/** Build the walkable grid. `seeds` are known floor points (scan points); the floor height is their median. */
export function buildWalkGrid(surfaces: Float32Array, seeds: Vec3[], options: WalkOptions = {}): WalkGrid {
  const cell = options.cell ?? 0.1;
  const bandMin = options.bandMinM ?? 0.15, bandMax = options.bandMaxM ?? 1.9;
  const radius = options.radiusM ?? 30;
  const zs = seeds.map((s) => s.z).sort((a, b) => a - b);
  const floorZ = zs.length ? zs[Math.floor(zs.length / 2)] : 0;
  const cx = seeds.reduce((s, p) => s + p.x, 0) / (seeds.length || 1);
  const cy = seeds.reduce((s, p) => s + p.y, 0) / (seeds.length || 1);

  // Bounds: mesh extent near the floor, limited to `radius` around the seeds.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < surfaces.length; i += 3) {
    const x = surfaces[i], y = surfaces[i + 1], z = surfaces[i + 2];
    if (z < floorZ - 0.3 || z > floorZ + bandMax || Math.abs(x - cx) > radius || Math.abs(y - cy) > radius) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return { minX: cx, minY: cy, cell, nx: 0, ny: 0, floorZ, clearance: new Float32Array(0) };
  const nx = Math.ceil((maxX - minX) / cell) + 1, ny = Math.ceil((maxY - minY) / cell) + 1;
  const floor = new Uint8Array(nx * ny), blocked = new Uint8Array(nx * ny);
  const mark = (grid: Uint8Array, x: number, y: number) => {
    const ix = Math.floor((x - minX) / cell), iy = Math.floor((y - minY) / cell);
    if (ix >= 0 && iy >= 0 && ix < nx && iy < ny) grid[iy * nx + ix] = 1;
  };

  for (let i = 0; i < surfaces.length; i += 9) {
    const ax = surfaces[i], ay = surfaces[i + 1], az = surfaces[i + 2];
    const bx = surfaces[i + 3], by = surfaces[i + 4], bz = surfaces[i + 5];
    const qx = surfaces[i + 6], qy = surfaces[i + 7], qz = surfaces[i + 8];
    const zMin = Math.min(az, bz, qz) - floorZ, zMax = Math.max(az, bz, qz) - floorZ;
    const inBand = zMax >= bandMin && zMin <= bandMax;
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = qx - ax, e2y = qy - ay, e2z = qz - az;
    const nz = e1x * e2y - e1y * e2x, nl = Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, nz) || 1;
    const isFloor = Math.abs(nz / nl) > 0.85 && zMax < 0.1 && zMin > -0.15;
    if (!inBand && !isFloor) continue;
    if (Math.abs(ax - cx) > radius + 5 || Math.abs(ay - cy) > radius + 5) continue;
    // Sample the triangle densely enough to touch every cell it covers.
    const longest = Math.max(Math.hypot(e1x, e1y, e1z), Math.hypot(e2x, e2y, e2z), Math.hypot(qx - bx, qy - by, qz - bz));
    const n = Math.max(1, Math.ceil(longest / (cell * 0.5)));
    for (let s = 0; s <= n; s++) {
      for (let t = 0; t <= n - s; t++) {
        const u = s / n, v = t / n;
        const x = ax + e1x * u + e2x * v, y = ay + e1y * u + e2y * v, z = az + e1z * u + e2z * v - floorZ;
        if (isFloor) mark(floor, x, y);
        else if (z >= bandMin && z <= bandMax) mark(blocked, x, y);
      }
    }
  }

  // Close small holes in the scanned floor (dilate then erode by 2 cells), then free = floor and not blocked.
  const closed = erode(dilate(floor, nx, ny, 2), nx, ny, 2);
  const free = new Uint8Array(nx * ny);
  for (let i = 0; i < free.length; i++) free[i] = closed[i] && !blocked[i] ? 1 : 0;
  return { minX, minY, cell, nx, ny, floorZ, clearance: distanceTransform(free, nx, ny, cell) };
}

function dilate(src: Uint8Array, nx: number, ny: number, r: number) {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    if (!src[y * nx + x]) continue;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const X = x + dx, Y = y + dy;
      if (X >= 0 && Y >= 0 && X < nx && Y < ny) out[Y * nx + X] = 1;
    }
  }
  return out;
}

function erode(src: Uint8Array, nx: number, ny: number, r: number) {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    let all = 1;
    for (let dy = -r; dy <= r && all; dy++) for (let dx = -r; dx <= r; dx++) {
      const X = x + dx, Y = y + dy;
      if (X < 0 || Y < 0 || X >= nx || Y >= ny || !src[Y * nx + X]) { all = 0; break; }
    }
    out[y * nx + x] = all;
  }
  return out;
}

/** Two-pass chamfer (3-4) distance to the nearest non-free cell, in metres. */
function distanceTransform(free: Uint8Array, nx: number, ny: number, cell: number) {
  const d = new Float32Array(free.length);
  const BIG = 1e9;
  for (let i = 0; i < d.length; i++) d[i] = free[i] ? BIG : 0;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= nx || y >= ny ? 0 : d[y * nx + x]);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = y * nx + x;
    if (!d[i]) continue;
    d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
  }
  for (let y = ny - 1; y >= 0; y--) for (let x = nx - 1; x >= 0; x--) {
    const i = y * nx + x;
    if (!d[i]) continue;
    d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
  }
  for (let i = 0; i < d.length; i++) d[i] = (d[i] / 3) * cell;
  return d;
}

/** Clearance at a floor point (0 outside the grid). */
export function clearanceAt(g: WalkGrid, p: { x: number; y: number }): number {
  const ix = Math.floor((p.x - g.minX) / g.cell), iy = Math.floor((p.y - g.minY) / g.cell);
  return ix >= 0 && iy >= 0 && ix < g.nx && iy < g.ny ? g.clearance[iy * g.nx + ix] : 0;
}

/** True when every point of the segment has at least `minClearM` clearance. */
export function segmentWalkable(g: WalkGrid, a: { x: number; y: number }, b: { x: number; y: number }, minClearM: number): boolean {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(len / (g.cell * 0.5)));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (clearanceAt(g, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }) < minClearM) return false;
  }
  return true;
}

export interface AisleOptions {
  /** Roughly one point per this many metres. */
  spacingM?: number;
  /** Minimum clearance for a point (half the narrowest aisle to walk). */
  minClearM?: number;
  /** Link points up to this far apart when the line between them is clear. */
  linkM?: number;
}

export type AislePoint = { id: string; position: Vec3; neighbors: string[] };

/**
 * Standing points along the walkable floor reachable from the seeds, about one per `spacingM`, each on the most open
 * cell of its block (the middle of an aisle). Seeds (scan points) are linked in with the same rule.
 */
export function aislePoints(g: WalkGrid, seeds: { id: string; position: Vec3 }[], options: AisleOptions = {}): { points: AislePoint[]; links: [string, string][] } {
  const spacing = options.spacingM ?? 1, minClear = options.minClearM ?? 0.3, linkM = options.linkM ?? 1.7;
  if (!g.nx) return { points: [], links: [] };
  // Cells reachable from any seed while staying at least `minClear` (seeds may stand a little closer to things).
  const reach = new Uint8Array(g.nx * g.ny);
  const queue: number[] = [];
  for (const s of seeds) {
    const ix = Math.floor((s.position.x - g.minX) / g.cell), iy = Math.floor((s.position.y - g.minY) / g.cell);
    // Start from the most open cell within 40 cm of the seed.
    let best = -1, bestC = 0;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const X = ix + dx, Y = iy + dy;
      if (X < 0 || Y < 0 || X >= g.nx || Y >= g.ny) continue;
      const c = g.clearance[Y * g.nx + X];
      if (c > bestC) { bestC = c; best = Y * g.nx + X; }
    }
    if (best >= 0 && bestC >= minClear && !reach[best]) { reach[best] = 1; queue.push(best); }
  }
  while (queue.length) {
    const i = queue.pop()!;
    const x = i % g.nx, y = (i - x) / g.nx;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const X = x + dx, Y = y + dy;
      if (X < 0 || Y < 0 || X >= g.nx || Y >= g.ny) continue;
      const j = Y * g.nx + X;
      if (!reach[j] && g.clearance[j] >= minClear) { reach[j] = 1; queue.push(j); }
    }
  }

  // One candidate per block: its most open reachable cell.
  const block = Math.max(1, Math.round(spacing / g.cell));
  const candidates: { bx: number; by: number; x: number; y: number; c: number }[] = [];
  for (let by = 0; by * block < g.ny; by++) for (let bx = 0; bx * block < g.nx; bx++) {
    let best: { x: number; y: number; c: number } | null = null;
    for (let y = by * block; y < Math.min(g.ny, (by + 1) * block); y++) for (let x = bx * block; x < Math.min(g.nx, (bx + 1) * block); x++) {
      const i = y * g.nx + x;
      if (reach[i] && (!best || g.clearance[i] > best.c)) best = { x, y, c: g.clearance[i] };
    }
    if (best) candidates.push({ bx, by, ...best });
  }
  // Most open first; skip any point too close to a seed or to a point already placed.
  candidates.sort((a, b) => b.c - a.c);
  const minGap = spacing * 0.65;
  const placed: { x: number; y: number }[] = seeds.map((s) => s.position);
  const points: AislePoint[] = [];
  for (const c of candidates) {
    const p = { x: g.minX + (c.x + 0.5) * g.cell, y: g.minY + (c.y + 0.5) * g.cell };
    if (placed.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < minGap)) continue;
    placed.push(p);
    points.push({ id: `aisle-${c.bx}-${c.by}`, position: { x: p.x, y: p.y, z: g.floorZ }, neighbors: [] });
  }

  // Links: clear straight lines up to `linkM`; isolated points get their nearest clear neighbour within 1.5×.
  const all = [...seeds.map((s) => ({ id: s.id, position: s.position, seed: true })), ...points.map((p) => ({ ...p, seed: false }))];
  const links: [string, string][] = [];
  const degree = new Map<string, number>();
  const add = (a: string, b: string) => { links.push([a, b]); degree.set(a, (degree.get(a) ?? 0) + 1); degree.set(b, (degree.get(b) ?? 0) + 1); };
  const clearLine = (a: { position: Vec3; seed: boolean }, b: { position: Vec3; seed: boolean }) =>
    segmentWalkable(g, a.position, b.position, a.seed || b.seed ? minClear * 0.6 : minClear * 0.8);
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    if (all[i].seed && all[j].seed) continue; // scan points keep Matterport's own links
    const d = Math.hypot(all[i].position.x - all[j].position.x, all[i].position.y - all[j].position.y);
    if (d <= linkM && clearLine(all[i], all[j])) add(all[i].id, all[j].id);
  }
  for (const p of all) {
    if (degree.get(p.id)) continue;
    const near = all
      .filter((q) => q.id !== p.id)
      .map((q) => ({ q, d: Math.hypot(q.position.x - p.position.x, q.position.y - p.position.y) }))
      .filter(({ q, d }) => d <= linkM * 1.5 && segmentWalkable(g, p.position, q.position, minClear * 0.5))
      .sort((a, b) => a.d - b.d)[0];
    if (near) add(p.id, near.q.id);
  }
  for (const [a, b] of links) {
    points.find((p) => p.id === a)?.neighbors.push(b);
    points.find((p) => p.id === b)?.neighbors.push(a);
  }
  return { points, links };
}

/** Typical camera height above the floor, from the scan points that have both. */
function eyeHeight(waypoints: Waypoint[]) {
  const h = waypoints.flatMap((w) => (w.camera ? [w.camera.z - w.position.z] : []));
  return h.length ? h.reduce((a, b) => a + b, 0) / h.length : 1.35;
}

/**
 * Scan points plus aisle points: extra standing points on the walkable floor (from the mesh), linked to each other
 * and to the scan points wherever the straight line is clear. Pure given its inputs; cached per mesh.
 */
export function withAislePoints(waypoints: Waypoint[], surfaces: Float32Array): { waypoints: Waypoint[]; walk: WalkGrid } {
  const walk = buildWalkGrid(surfaces, waypoints.map((w) => w.position));
  const { points, links } = aislePoints(walk, waypoints.map((w) => ({ id: w.id, position: w.position })));
  const eye = eyeHeight(waypoints);
  const floorId = waypoints[0]?.floorId ?? null;
  const out: Waypoint[] = waypoints.map((w) => ({ ...w, kind: "photo" as const, neighbors: [...w.neighbors] }));
  const byId = new Map(out.map((w) => [w.id, w]));
  for (const p of points) {
    const w: Waypoint = {
      id: p.id, kind: "aisle", position: p.position, camera: { ...p.position, z: p.position.z + eye },
      floorId, neighbors: [...p.neighbors],
    };
    out.push(w);
    byId.set(w.id, w);
  }
  for (const [a, b] of links) {
    for (const [x, y] of [[a, b], [b, a]]) {
      const w = byId.get(x);
      if (w?.kind === "photo" && !w.neighbors.includes(y)) w.neighbors.push(y);
    }
  }
  return { waypoints: out, walk };
}
