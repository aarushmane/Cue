// The route as drawn while the visitor walks: from their feet onward, so the part already walked disappears and the
// band always starts where they stand. Pure, so it is unit tested.
import { floorPath } from "../wayfinding/pano";
import { pointAlong, progressAlong } from "../wayfinding/screen";
import type { Vec3 } from "../wayfinding/types";
import { clearance, type SimGrid } from "./walk";

/** True when a straight line on the floor stays on walkable floor (not through a shelf). */
function walkable(g: SimGrid | null, a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  if (!g) return true;
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (g.cell * 0.5)));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (clearance(g, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) < 0.05) return false;
  }
  return true;
}

/**
 * The remaining path: the planned route (continued to just short of the item), cut at the point nearest the visitor
 * and started at their feet. When they have stepped off the route, a connector joins them back to it — unless that
 * line would cross a shelf, in which case the route is drawn from its nearest point until the next re-plan arrives.
 */
export function livePath(polyline: Vec3[], item: Vec3, floor: { x: number; y: number }, grid: SimGrid | null = null): Vec3[] {
  const full = floorPath(polyline, item);
  if (full.length < 2) return full;
  const z = full[0].z;
  const here = { x: floor.x, y: floor.y, z };
  const { atM, point } = progressAlong(full, here);
  const rest: Vec3[] = [{ x: point.x, y: point.y, z }];
  let walked = 0;
  for (let i = 0; i < full.length - 1; i++) {
    walked += Math.hypot(full[i + 1].x - full[i].x, full[i + 1].y - full[i].y);
    if (walked > atM + 1e-6) rest.push(full[i + 1]);
  }
  if (rest.length < 2) rest.push(pointAlong(full, atM + 0.01));
  const gap = Math.hypot(point.x - here.x, point.y - here.y);
  return gap > 0.05 && walkable(grid, here, point) ? [here, ...rest] : rest;
}
