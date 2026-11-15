// Camera math for the built-in 360° viewer: a pinhole camera standing at a scan point's camera centre, looking along a
// heading/pitch in the Model API frame (z up). Used to draw the route as shapes lying on the floor, in perspective.
import { add, cross, dot, normalize, sub, v3 } from "./geometry";
import type { Projector } from "./screen";
import type { Quat, Vec3 } from "./types";

export type PanoCamera = {
  eye: Vec3;
  /** Heading, degrees: 0° = +x, counter-clockwise positive (same convention as the planner). */
  yawDeg: number;
  /** Up positive, degrees. */
  pitchDeg: number;
  /** Vertical field of view, degrees. */
  vfovDeg: number;
  w: number;
  h: number;
};

const RAD = Math.PI / 180;
/** Points closer than this in front of the camera are clipped away. */
const NEAR_M = 0.05;

/** Camera axes in the model frame. */
export function viewBasis(yawDeg: number, pitchDeg: number): { fwd: Vec3; right: Vec3; up: Vec3 } {
  const y = yawDeg * RAD, p = pitchDeg * RAD;
  const fwd = v3(Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), Math.sin(p));
  const right = v3(Math.sin(y), -Math.cos(y), 0);
  return { fwd, right, up: cross(right, fwd) };
}

export const focalPx = (cam: PanoCamera) => cam.h / 2 / Math.tan((cam.vfovDeg * RAD) / 2);

/** Model point → camera space: x right, y up, z depth along the view direction. */
export function toCamera(cam: PanoCamera, p: Vec3, basis = viewBasis(cam.yawDeg, cam.pitchDeg)): Vec3 {
  const d = sub(p, cam.eye);
  return v3(dot(d, basis.right), dot(d, basis.up), dot(d, basis.fwd));
}

/**
 * Projector for the screen helpers. Points in front get z = 0; points behind get z = 2 and are mirrored through the
 * screen centre toward the side they are on (the convention `edgeIndicator` expects).
 */
export function panoProjector(cam: PanoCamera): Projector {
  const basis = viewBasis(cam.yawDeg, cam.pitchDeg);
  const f = focalPx(cam);
  return (p) => {
    const c = toCamera(cam, p, basis);
    if (c.z < NEAR_M) return { x: cam.w / 2 - Math.sign(c.x || 1) * cam.w, y: cam.h / 2, z: 2 };
    return { x: cam.w / 2 + (f * c.x) / c.z, y: cam.h / 2 - (f * c.y) / c.z, z: 0 };
  };
}

/**
 * A 3D polygon (e.g. lying on the floor) → screen polygon, clipped where it passes behind the camera. Straight edges
 * stay straight under perspective, so only the clip points need computing. Empty when entirely behind.
 */
export function projectPolygon(cam: PanoCamera, points: Vec3[]): { x: number; y: number }[] {
  const basis = viewBasis(cam.yawDeg, cam.pitchDeg);
  const f = focalPx(cam);
  const c = points.map((p) => toCamera(cam, p, basis));
  const clipped: Vec3[] = [];
  for (let i = 0; i < c.length; i++) {
    const a = c[i], b = c[(i + 1) % c.length];
    const aIn = a.z >= NEAR_M, bIn = b.z >= NEAR_M;
    if (aIn) clipped.push(a);
    if (aIn !== bIn) {
      const t = (NEAR_M - a.z) / (b.z - a.z);
      clipped.push(v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, NEAR_M));
    }
  }
  return clipped.map((p) => ({ x: cam.w / 2 + (f * p.x) / p.z, y: cam.h / 2 - (f * p.y) / p.z }));
}

/** Outline of a band of the given half-width centred on the polyline, on the floor plane (mitred corners). */
export function ribbon(polyline: Vec3[], halfWidthM: number, lift = 0.01): Vec3[] {
  const pts = polyline.filter((p, i) => i === 0 || Math.hypot(p.x - polyline[i - 1].x, p.y - polyline[i - 1].y) > 1e-3);
  if (pts.length < 2) return [];
  const normal = (a: Vec3, b: Vec3) => { const d = normalize(v3(b.x - a.x, b.y - a.y, 0)); return v3(-d.y, d.x, 0); };
  const left: Vec3[] = [], right: Vec3[] = [];
  for (let i = 0; i < pts.length; i++) {
    const n0 = i > 0 ? normal(pts[i - 1], pts[i]) : normal(pts[0], pts[1]);
    const n1 = i < pts.length - 1 ? normal(pts[i], pts[i + 1]) : n0;
    const m = normalize(add(n0, n1));
    // Mitre length grows at sharp corners; cap it so a hairpin doesn't spike.
    const k = halfWidthM / Math.max(0.35, dot(m, n0));
    const p = v3(pts[i].x, pts[i].y, pts[i].z + lift);
    left.push(add(p, v3(m.x * k, m.y * k, 0)));
    right.push(sub(p, v3(m.x * k, m.y * k, 0)));
  }
  return [...left, ...right.reverse()];
}

/** A chevron lying on the floor at `p`, pointing along `headingDeg`. */
export function floorChevron(p: Vec3, headingDeg: number, sizeM = 0.32, lift = 0.015): Vec3[] {
  const h = headingDeg * RAD;
  const f = v3(Math.cos(h), Math.sin(h), 0), l = v3(-Math.sin(h), Math.cos(h), 0);
  const at = (fw: number, lt: number) => v3(p.x + (f.x * fw + l.x * lt) * sizeM, p.y + (f.y * fw + l.y * lt) * sizeM, p.z + lift);
  return [at(0.55, 0), at(-0.35, 0.5), at(-0.1, 0), at(-0.35, -0.5)];
}

/** A flat disc on the floor (as a polygon). */
export function floorDisc(p: Vec3, radiusM: number, segments = 32, lift = 0.01): Vec3[] {
  return Array.from({ length: segments }, (_, i) => {
    const a = (i / segments) * Math.PI * 2;
    return v3(p.x + Math.cos(a) * radiusM, p.y + Math.sin(a) * radiusM, p.z + lift);
  });
}

/** Heading and pitch that look from `eye` at `target`. */
export function lookAtAngles(eye: Vec3, target: Vec3): { yawDeg: number; pitchDeg: number } {
  const d = sub(target, eye);
  return { yawDeg: Math.atan2(d.y, d.x) / RAD, pitchDeg: Math.atan2(d.z, Math.hypot(d.x, d.y)) / RAD };
}

/** The inverse rotation (model → pano-local) the viewer's shader needs. */
export const conjugate = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });

/**
 * The path to draw on the floor: the planned route, continued from the stand point to just short of the spot under
 * the item, so even "you're already here" shows which way to walk.
 */
export function floorPath(polyline: Vec3[], item: Vec3, stopShortM = 0.45): Vec3[] {
  if (!polyline.length) return [];
  const last = polyline[polyline.length - 1];
  const dx = item.x - last.x, dy = item.y - last.y, d = Math.hypot(dx, dy);
  if (d <= stopShortM + 0.15) return polyline;
  const k = (d - stopShortM) / d;
  return [...polyline, v3(last.x + dx * k, last.y + dy * k, last.z)];
}

/** Chevron positions every `spacingM` along a floor path, starting `startM` in, each pointing along the path. */
export function chevronsAlong(path: Vec3[], spacingM = 0.8, startM = 0.6): { position: Vec3; headingDeg: number }[] {
  const out: { position: Vec3; headingDeg: number }[] = [];
  let walked = 0, next = startM;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const heading = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    while (len > 0 && next <= walked + len) {
      const t = (next - walked) / len;
      out.push({ position: v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t), headingDeg: heading });
      next += spacingM;
    }
    walked += len;
  }
  return out;
}
