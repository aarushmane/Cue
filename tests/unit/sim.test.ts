import { describe, expect, it, vi } from "vitest";
import { clearance, nearestOpen, walk, type SimGrid } from "@/lib/sim/walk";

vi.mock("server-only", () => ({}));

// 4 × 4 m room on a 10 cm grid with a shelf (blocked) at x 1.5–2.5, y 1–3. Clearance = distance to the shelf or wall.
function room(): SimGrid {
  const nx = 40, ny = 40, cell = 0.1;
  const c = new Uint8Array(nx * ny);
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
    const x = (ix + 0.5) * cell, y = (iy + 0.5) * cell;
    const toWall = Math.min(x, y, 4 - x, 4 - y);
    const dx = Math.max(1.5 - x, 0, x - 2.5), dy = Math.max(1 - y, 0, y - 3);
    const toShelf = Math.hypot(dx, dy);
    c[iy * nx + ix] = Math.min(255, Math.round(Math.min(toWall, toShelf) * 100));
  }
  return { minX: 0, minY: 0, cell, nx, ny, floorZ: 0, eyeHeight: 1.35, clearance: c };
}

describe("walking in the simulation", () => {
  const g = room();
  it("walks freely in the open", () => {
    const p = walk(g, { x: 0.5, y: 0.5 }, 0.5, 0);
    expect(p.x).toBeCloseTo(1);
    expect(p.y).toBeCloseTo(0.5);
  });
  it("stops short of a shelf instead of passing through it", () => {
    const p = walk(g, { x: 0.8, y: 2 }, 2.5, 0); // straight at the shelf's west face
    expect(p.x).toBeLessThan(1.5 - 0.2);
    expect(clearance(g, p.x, p.y)).toBeGreaterThanOrEqual(0.22);
  });
  it("slides along the shelf when walking into it at an angle", () => {
    const p = walk(g, { x: 1.2, y: 1.5 }, 0.5, 0.5);
    expect(p.y).toBeGreaterThan(1.9); // kept the sideways part of the move
    expect(p.x).toBeLessThan(1.5);
  });
  it("gets someone out of a tight spot", () => {
    const stuck = { x: 1.45, y: 2 }; // 5 cm from the shelf
    const out = nearestOpen(g, stuck);
    expect(clearance(g, out.x, out.y)).toBeGreaterThanOrEqual(0.22);
    expect(walk(g, stuck, -0.3, 0).x).toBeCloseTo(1.15); // moving away is allowed
  });
});

describe("MatterPak mesh packing", () => {
  it("indexes OBJ vertices with their UVs and groups triangles by texture", async () => {
    const { packObj } = await import("@/lib/sim/matterpak");
    const obj = [
      "v 0 0 0", "v 1 0 0", "v 1 1 0", "v 0 1 0",
      "vt 0 0", "vt 1 0", "vt 1 1", "vt 0 1",
      "usemtl a", "f 1/1 2/2 3/3 4/4", // quad → 2 triangles
      "usemtl b", "f 1/1 3/3 4/4",
    ].join("\n");
    const packed = packObj(obj, new Map([["a", "a.jpg"], ["b", "b.jpg"]]));
    expect(packed.header.vertices).toBe(4); // shared (v, vt) pairs reused
    expect(packed.header.groups).toEqual([{ texture: "a.jpg", start: 0, count: 6 }, { texture: "b.jpg", start: 6, count: 3 }]);
    expect(Array.from(packed.indices)).toEqual([0, 1, 2, 0, 2, 3, 0, 2, 3]);
    expect(Array.from(packed.uvs.slice(4, 6))).toEqual([1, 1]);
  });
});

describe("the route drawn while walking", () => {
  it("starts at the visitor's feet and drops the part already walked", async () => {
    const { livePath } = await import("@/lib/sim/livePath");
    const route = [{ x: 0.5, y: 0.5, z: 0 }, { x: 3.5, y: 0.5, z: 0 }, { x: 3.5, y: 3.5, z: 0 }];
    const item = { x: 3.5, y: 3.9, z: 1 };
    const g = room();
    const onRoute = livePath(route, item, { x: 2, y: 0.5 }, g);
    expect(onRoute[0]).toMatchObject({ x: 2, y: 0.5 });
    expect(onRoute.every((p) => p.x >= 2 - 1e-9)).toBe(true); // nothing behind the visitor
    const off = livePath(route, item, { x: 2, y: 0.8 }, g); // stepped 30 cm off the route
    expect(off[0]).toMatchObject({ x: 2, y: 0.8 }); // connector from the feet
    expect(off[1]).toMatchObject({ x: 2, y: 0.5 });
  });
  it("does not draw a connector through a shelf", async () => {
    const { livePath } = await import("@/lib/sim/livePath");
    const g = room(); // shelf at x 1.5–2.5, y 1–3
    const route = [{ x: 1.2, y: 0.5, z: 0 }, { x: 1.2, y: 3.5, z: 0 }];
    const path = livePath(route, { x: 1.2, y: 3.9, z: 1 }, { x: 2.8, y: 2 }, g); // visitor east of the shelf
    expect(path[0].x).toBeCloseTo(1.2); // starts on the route, not at the feet across the shelf
  });
});
