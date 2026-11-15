// Screen-space helpers for drawing a route over the 3D tour. Frame-agnostic: the caller supplies a projector that
// maps a model-frame point to screen pixels. In the browser that is
//   p => mpSdk.Conversion.worldToScreen(mpSdk.Conversion.basisChange(p, TO_SDK), pose, size)
// and in tests a plain pinhole camera.
import { add, dist2, length, lerp, sub, v3 } from "./geometry";
import type { RouteArrow, Vec3 } from "./types";

/** Screen pixels plus normalised depth: z in [-1, 1] is in front of the camera and inside the view volume. */
export type ScreenPoint = { x: number; y: number; z: number };
export type Projector = (p: Vec3) => ScreenPoint;
export type Size = { w: number; h: number };

const visible = (s: ScreenPoint) => Number.isFinite(s.x) && Number.isFinite(s.y) && s.z >= -1 && s.z <= 1;

/** Distance along the polyline of the point nearest to `p` (floor plane), and that point. */
export function progressAlong(polyline: Vec3[], p: Vec3): { atM: number; point: Vec3; offRouteM: number } {
  let best = { atM: 0, point: polyline[0], offRouteM: Infinity };
  let walked = 0;
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i], b = polyline[i + 1];
    const seg = sub(b, a);
    const l2 = seg.x * seg.x + seg.y * seg.y;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * seg.x + (p.y - a.y) * seg.y) / l2)) : 0;
    const q = lerp(a, b, t);
    const d = dist2(q, p);
    if (d < best.offRouteM) best = { atM: walked + t * length(seg), point: q, offRouteM: d };
    walked += length(seg);
  }
  if (polyline.length === 1) best = { atM: 0, point: polyline[0], offRouteM: dist2(polyline[0], p) };
  return best;
}

/** The point `atM` metres along the polyline (clamped to its ends). */
export function pointAlong(polyline: Vec3[], atM: number): Vec3 {
  let walked = 0;
  for (let i = 0; i < polyline.length - 1; i++) {
    const l = length(sub(polyline[i + 1], polyline[i]));
    if (walked + l >= atM) return lerp(polyline[i], polyline[i + 1], l > 0 ? (atM - walked) / l : 0);
    walked += l;
  }
  return polyline[polyline.length - 1];
}

/** Where to look next: `aheadM` further along the route than the visitor's closest point on it. */
export function lookAhead(polyline: Vec3[], visitor: Vec3, aheadM = 2): Vec3 {
  return pointAlong(polyline, progressAlong(polyline, visitor).atM + aheadM);
}

export type ScreenArrow = { x: number; y: number; angleRad: number; sizePx: number; atM: number };

/**
 * Floor arrows as 2D chevrons: screen position, rotation (radians, 0 = pointing right, clockwise positive because
 * screen y points down) and an on-screen size that shrinks with distance. Arrows behind the camera are dropped.
 */
export function projectArrows(arrows: RouteArrow[], project: Projector, size: Size, arrowLengthM = 0.45): ScreenArrow[] {
  const out: ScreenArrow[] = [];
  for (const a of arrows) {
    const h = (a.headingDeg * Math.PI) / 180;
    const tail = project(a.position);
    const tip = project(add(a.position, v3(Math.cos(h) * arrowLengthM, Math.sin(h) * arrowLengthM, 0)));
    if (!visible(tail) || !visible(tip)) continue;
    const dx = tip.x - tail.x, dy = tip.y - tail.y;
    const sizePx = Math.hypot(dx, dy);
    if (sizePx < 3 || tail.x < -50 || tail.y < -50 || tail.x > size.w + 50 || tail.y > size.h + 50) continue;
    out.push({ x: (tail.x + tip.x) / 2, y: (tail.y + tip.y) / 2, angleRad: Math.atan2(dy, dx), sizePx: Math.min(sizePx, 160), atM: a.atM });
  }
  return out;
}

/**
 * The route as screen-space line runs, split wherever it leaves the view volume. Sampled so long legs bend correctly.
 * Where the route passes behind the camera the run is cut exactly at the view-volume boundary, so the line reaches the
 * screen edge (the floor at the visitor's feet) instead of stopping at the last sample in front.
 */
export function projectPolyline(polyline: Vec3[], project: Projector, stepM = 0.25): { x: number; y: number }[][] {
  const runs: { x: number; y: number }[][] = [];
  let run: { x: number; y: number }[] = [];
  let prev: { p: Vec3; seen: boolean } | null = null;
  const boundary = (inside: Vec3, outside: Vec3) => {
    let a = inside, b = outside;
    for (let i = 0; i < 12; i++) {
      const m = lerp(a, b, 0.5);
      if (visible(project(m))) a = m; else b = m;
    }
    const s = project(a);
    return { x: s.x, y: s.y };
  };
  const push = (p: Vec3) => {
    const s = project(p);
    const seen = visible(s);
    if (seen) {
      if (prev && !prev.seen) run.push(boundary(p, prev.p));
      run.push({ x: s.x, y: s.y });
    } else if (run.length && prev) {
      run.push(boundary(prev.p, p));
      if (run.length > 1) runs.push(run);
      run = [];
    }
    prev = { p, seen };
  };
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i], b = polyline[i + 1];
    const n = Math.max(1, Math.ceil(length(sub(b, a)) / stepM));
    for (let k = 0; k < n; k++) push(lerp(a, b, k / n));
  }
  if (polyline.length) push(polyline[polyline.length - 1]);
  if (run.length > 1) runs.push(run);
  return runs;
}

/**
 * When the target is off screen (or behind the camera), an indicator on the screen edge pointing toward it.
 * Returns null when the target is visible.
 */
export function edgeIndicator(target: ScreenPoint, size: Size, marginPx = 40): { x: number; y: number; angleRad: number } | null {
  const inFront = target.z >= -1 && target.z <= 1;
  const onScreen = inFront && target.x >= marginPx && target.x <= size.w - marginPx && target.y >= marginPx && target.y <= size.h - marginPx;
  if (onScreen) return null;
  const cx = size.w / 2, cy = size.h / 2;
  let dx = target.x - cx, dy = target.y - cy;
  // Behind the camera, projected coordinates are mirrored through the centre.
  if (!inFront) { dx = -dx; dy = -dy; }
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) { dx = 0; dy = 1; }
  const k = Math.min((cx - marginPx) / Math.abs(dx || 1e-9), (cy - marginPx) / Math.abs(dy || 1e-9));
  return { x: cx + dx * k, y: cy + dy * k, angleRad: Math.atan2(dy, dx) };
}
