// Small, dependency-free geometry used by locate (rays, triangulation) and plan (clearance, headings).
import type { Obstacle, Quat, Vec3 } from "./types";

export const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
export const add = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, k: number): Vec3 => v3(a.x * k, a.y * k, a.z * k);
export const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const length = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
export const normalize = (a: Vec3): Vec3 => { const l = length(a) || 1; return scale(a, 1 / l); };
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => add(a, scale(sub(b, a), t));
/** Distance on the floor plane (ignores z). */
export const dist2 = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y);

/** Rotate `v` by unit quaternion `q`. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const u = v3(q.x, q.y, q.z);
  const t = scale(cross(u, v), 2);
  return add(add(v, scale(t, q.w)), cross(u, t));
}

/** Heading of a → b on the floor plane: degrees, 0° = +x, counter-clockwise positive. */
export function headingDeg(a: Vec3, b: Vec3): number {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

/** Signed change from heading `from` to heading `to`, in (-180, 180]. Positive = counter-clockwise = a LEFT turn. */
export function turnDeg(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d <= -180) d += 360;
  if (d > 180) d -= 360;
  return d;
}

export type Ray = { origin: Vec3; dir: Vec3 };

/**
 * Least-squares point closest to every ray (minimises Σ squared perpendicular distance). Returns null when the
 * rays are (near) parallel, i.e. the system is ill-conditioned. `residualM` is the RMS distance from point to rays.
 */
export function triangulate(rays: Ray[]): { point: Vec3; residualM: number; spreadDeg: number } | null {
  if (rays.length < 2) return null;
  // A p = b, with A = Σ (I − d dᵀ), b = Σ (I − d dᵀ) o
  const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const b = [0, 0, 0];
  for (const { origin: o, dir } of rays) {
    const d = normalize(dir);
    const dd = [d.x, d.y, d.z];
    const oo = [o.x, o.y, o.z];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const m = (i === j ? 1 : 0) - dd[i] * dd[j];
        A[i * 3 + j] += m;
        b[i] += m * oo[j];
      }
    }
  }
  const det =
    A[0] * (A[4] * A[8] - A[5] * A[7]) - A[1] * (A[3] * A[8] - A[5] * A[6]) + A[2] * (A[3] * A[7] - A[4] * A[6]);
  if (Math.abs(det) < 1e-6) return null;
  const inv = [
    A[4] * A[8] - A[5] * A[7], A[2] * A[7] - A[1] * A[8], A[1] * A[5] - A[2] * A[4],
    A[5] * A[6] - A[3] * A[8], A[0] * A[8] - A[2] * A[6], A[2] * A[3] - A[0] * A[5],
    A[3] * A[7] - A[4] * A[6], A[1] * A[6] - A[0] * A[7], A[0] * A[4] - A[1] * A[3],
  ].map((x) => x / det);
  const point = v3(
    inv[0] * b[0] + inv[1] * b[1] + inv[2] * b[2],
    inv[3] * b[0] + inv[4] * b[1] + inv[5] * b[2],
    inv[6] * b[0] + inv[7] * b[1] + inv[8] * b[2],
  );
  let sq = 0;
  for (const r of rays) {
    const d = normalize(r.dir);
    const w = sub(point, r.origin);
    sq += length(sub(w, scale(d, dot(w, d)))) ** 2;
  }
  // Widest angle between any two rays: small angles mean depth along the rays is poorly constrained.
  let spread = 0;
  for (let i = 0; i < rays.length; i++) {
    for (let j = i + 1; j < rays.length; j++) {
      const c = Math.min(1, Math.abs(dot(normalize(rays[i].dir), normalize(rays[j].dir))));
      spread = Math.max(spread, (Math.acos(c) * 180) / Math.PI);
    }
  }
  return { point, residualM: Math.sqrt(sq / rays.length), spreadDeg: spread };
}

/** First hit of a ray with an obstacle box extruded over [zMin, zMax] (slab method). Returns distance along the ray. */
export function rayHitsBox(ray: Ray, box: Extract<Obstacle, { kind: "box" }>, zMin = -Infinity, zMax = Infinity): number | null {
  let t0 = 0;
  let t1 = Infinity;
  const o = [ray.origin.x, ray.origin.y, ray.origin.z];
  const d = [ray.dir.x, ray.dir.y, ray.dir.z];
  const lo = [box.minX, box.minY, zMin];
  const hi = [box.maxX, box.maxY, zMax];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) {
      if (o[i] < lo[i] || o[i] > hi[i]) return null;
      continue;
    }
    let a = (lo[i] - o[i]) / d[i];
    let c = (hi[i] - o[i]) / d[i];
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, c);
    if (t0 > t1) return null;
  }
  return t0;
}

// ── Floor-plane clearance ────────────────────────────────────────────────────────────────────────

function segmentsIntersect(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number) {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = o(cx, cy, dx, dy, ax, ay);
  const d2 = o(cx, cy, dx, dy, bx, by);
  const d3 = o(ax, ay, bx, by, cx, cy);
  const d4 = o(ax, ay, bx, by, dx, dy);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Distance between two segments on the floor plane (0 when they cross). */
export function segmentDistance(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number {
  if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  const pointSeg = (px: number, py: number, sx: number, sy: number, ex: number, ey: number) => {
    const lx = ex - sx, ly = ey - sy;
    const l2 = lx * lx + ly * ly;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - sx) * lx + (py - sy) * ly) / l2)) : 0;
    return Math.hypot(px - (sx + lx * t), py - (sy + ly * t));
  };
  return Math.min(
    pointSeg(ax, ay, cx, cy, dx, dy), pointSeg(bx, by, cx, cy, dx, dy),
    pointSeg(cx, cy, ax, ay, bx, by), pointSeg(dx, dy, ax, ay, bx, by),
  );
}

/** True when segment a→b (floor plane) passes within `clearance` metres of the obstacle. */
export function segmentBlocked(a: Vec3, b: Vec3, o: Obstacle, clearance = 0): boolean {
  if (o.kind === "wall") return segmentDistance(a.x, a.y, b.x, b.y, o.ax, o.ay, o.bx, o.by) <= clearance;
  const inside = (p: Vec3) => p.x > o.minX - clearance && p.x < o.maxX + clearance && p.y > o.minY - clearance && p.y < o.maxY + clearance;
  if (inside(a) || inside(b)) return true;
  const edges: [number, number, number, number][] = [
    [o.minX, o.minY, o.maxX, o.minY], [o.maxX, o.minY, o.maxX, o.maxY],
    [o.maxX, o.maxY, o.minX, o.maxY], [o.minX, o.maxY, o.minX, o.minY],
  ];
  return edges.some(([cx, cy, dx, dy]) => segmentDistance(a.x, a.y, b.x, b.y, cx, cy, dx, dy) <= clearance);
}

/** Distance from point p to the nearest point of an obstacle on the floor plane (0 inside a box). */
export function pointObstacleDistance(p: Vec3, o: Obstacle): number {
  if (o.kind === "wall") return segmentDistance(p.x, p.y, p.x, p.y, o.ax, o.ay, o.bx, o.by);
  const dx = Math.max(o.minX - p.x, 0, p.x - o.maxX);
  const dy = Math.max(o.minY - p.y, 0, p.y - o.maxY);
  return Math.hypot(dx, dy);
}
