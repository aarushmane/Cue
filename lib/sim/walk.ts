// Walking in the simulation: keep the visitor on scanned floor and out of shelves, using the walkable grid the server
// builds from the scan mesh (lib/wayfinding/walkable.ts). Pure, so it is unit tested.
import type { Vec3 } from "../wayfinding/types";

export type SimGrid = {
  minX: number; minY: number; cell: number; nx: number; ny: number; floorZ: number; eyeHeight: number;
  /** Clearance per cell in centimetres (0 = blocked). */
  clearance: Uint8Array;
};

/** The /api/sim/walk response → grid. */
export function decodeGrid(json: { minX: number; minY: number; cell: number; nx: number; ny: number; floorZ: number; eyeHeight: number; clearance: string }): SimGrid {
  const bin = atob(json.clearance);
  const clearance = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) clearance[i] = bin.charCodeAt(i);
  return { ...json, clearance };
}

/** Metres of clearance at a floor point (0 outside the grid). */
export function clearance(g: SimGrid, x: number, y: number): number {
  const ix = Math.floor((x - g.minX) / g.cell), iy = Math.floor((y - g.minY) / g.cell);
  return ix >= 0 && iy >= 0 && ix < g.nx && iy < g.ny ? g.clearance[iy * g.nx + ix] / 100 : 0;
}

/** How close (metres) the visitor's centre may get to a shelf or wall. */
export const BODY_RADIUS_M = 0.22;

/**
 * Move from `p` by (dx, dy) on the floor. Steps that would end too close to an obstacle are cut; the visitor slides
 * along a shelf instead of stopping dead (each axis tried on its own). Someone already in a tight spot may move in
 * any direction that doesn't make it tighter, so they can't get stuck. Long moves are taken in small steps so a thin
 * shelf can't be jumped over.
 */
export function walk(g: SimGrid, p: { x: number; y: number }, dx: number, dy: number): { x: number; y: number } {
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (g.cell * 0.5)));
  let x = p.x, y = p.y;
  const ok = (fx: number, fy: number, tx: number, ty: number) => {
    const to = clearance(g, tx, ty);
    // In a tight spot (closer than BODY_RADIUS_M), any move that doesn't get tighter is allowed, so nobody gets stuck.
    return to >= BODY_RADIUS_M || (to > 0 && to >= clearance(g, fx, fy));
  };
  for (let i = 0; i < steps; i++) {
    const sx = dx / steps, sy = dy / steps;
    if (ok(x, y, x + sx, y + sy)) { x += sx; y += sy; }
    else if (sx && ok(x, y, x + sx, y)) x += sx;
    else if (sy && ok(x, y, x, y + sy)) y += sy;
    else break;
  }
  return { x, y };
}

/** Nearest point with comfortable clearance (where to put someone who starts inside an obstacle). */
export function nearestOpen(g: SimGrid, p: { x: number; y: number }, maxM = 2): { x: number; y: number } {
  if (clearance(g, p.x, p.y) >= BODY_RADIUS_M) return p;
  const r = Math.ceil(maxM / g.cell);
  let best: { x: number; y: number; d: number } | null = null;
  const cx = Math.floor((p.x - g.minX) / g.cell), cy = Math.floor((p.y - g.minY) / g.cell);
  for (let iy = Math.max(0, cy - r); iy <= Math.min(g.ny - 1, cy + r); iy++) {
    for (let ix = Math.max(0, cx - r); ix <= Math.min(g.nx - 1, cx + r); ix++) {
      if (g.clearance[iy * g.nx + ix] / 100 < BODY_RADIUS_M + 0.05) continue;
      const x = g.minX + (ix + 0.5) * g.cell, y = g.minY + (iy + 0.5) * g.cell;
      const d = Math.hypot(x - p.x, y - p.y);
      if (!best || d < best.d) best = { x, y, d };
    }
  }
  return best ? { x: best.x, y: best.y } : p;
}

/** Eye position for a floor point. */
export const eyeAt = (g: SimGrid, p: { x: number; y: number }): Vec3 => ({ x: p.x, y: p.y, z: g.floorZ + g.eyeHeight });
