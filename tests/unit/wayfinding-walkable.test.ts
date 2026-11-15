import { describe, expect, it } from "vitest";
import { planRouteToItem } from "@/lib/wayfinding/plan";
import { clearanceAt, segmentWalkable, withAislePoints } from "@/lib/wayfinding/walkable";
import type { SceneItem, Waypoint } from "@/lib/wayfinding/types";

// A 10 × 6 m room: floor, four walls, and one shelf (x 3–7, y 2.6–3.4, 1.6 m tall) splitting it into two aisles.
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] {
  const p = (x: number, y: number, z: number) => [x, y, z];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => [...a, ...b, ...c, ...a, ...c, ...d];
  return [
    ...quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)), // top
    ...quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)), // south
    ...quad(p(x0, y1, z0), p(x1, y1, z0), p(x1, y1, z1), p(x0, y1, z1)), // north
    ...quad(p(x0, y0, z0), p(x0, y1, z0), p(x0, y1, z1), p(x0, y0, z1)), // west
    ...quad(p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1)), // east
  ];
}
const floor = [0, 0, 0, 10, 0, 0, 10, 6, 0, 0, 0, 0, 10, 6, 0, 0, 6, 0];
const walls = [...box(-0.1, -0.1, 0, 10.1, 0, 2.5), ...box(-0.1, 6, 0, 10.1, 6.1, 2.5), ...box(-0.1, 0, 0, 0, 6, 2.5), ...box(10, 0, 0, 10.1, 6, 2.5)];
const MESH = Float32Array.from([...floor, ...walls, ...box(3, 2.6, 0, 7, 3.4, 1.6)]);
const SCAN: Waypoint[] = [{ id: "photo", position: { x: 1, y: 1, z: 0 }, camera: { x: 1, y: 1, z: 1.35 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, floorId: "f", neighbors: [], label: "0" }];

describe("aisle points from the scan mesh", () => {
  const { waypoints, walk } = withAislePoints(SCAN, MESH);
  const aisles = waypoints.filter((w) => w.kind === "aisle");

  it("marks the shelf as blocked and the aisles as walkable", () => {
    expect(clearanceAt(walk, { x: 5, y: 3 })).toBe(0); // inside the shelf
    expect(clearanceAt(walk, { x: 5, y: 1.3 })).toBeGreaterThan(0.5); // south aisle
    expect(clearanceAt(walk, { x: 5, y: 4.7 })).toBeGreaterThan(0.5); // north aisle
    expect(segmentWalkable(walk, { x: 5, y: 1.3 }, { x: 5, y: 4.7 }, 0.2)).toBe(false); // straight through the shelf
  });

  it("places linked points in both aisles, never on or across the shelf", () => {
    expect(aisles.some((w) => w.position.y < 2.4 && w.position.x > 3.5 && w.position.x < 6.5)).toBe(true);
    expect(aisles.some((w) => w.position.y > 3.6 && w.position.x > 3.5 && w.position.x < 6.5)).toBe(true);
    const byId = new Map(waypoints.map((w) => [w.id, w]));
    for (const w of aisles) {
      expect(clearanceAt(walk, w.position)).toBeGreaterThanOrEqual(0.3);
      expect(w.camera!.z).toBeCloseTo(1.35);
      for (const n of w.neighbors) {
        const o = byId.get(n)!;
        const crossesShelf = Math.min(w.position.y, o.position.y) < 2.6 && Math.max(w.position.y, o.position.y) > 3.4 && Math.max(w.position.x, o.position.x) > 3 && Math.min(w.position.x, o.position.x) < 7;
        expect(crossesShelf).toBe(false);
      }
    }
    expect(byId.get("photo")!.neighbors.length).toBeGreaterThan(0); // the scan point is linked in
  });

  it("routes to the aisle that faces the item, not the one behind its shelf", () => {
    // On the north face of the shelf: only visible from the north aisle.
    const item: SceneItem = { id: "i", name: "Takis", position: { x: 5, y: 3.4, z: 1 }, source: "vision" };
    const plan = planRouteToItem({ modelId: "m", waypoints, items: [item], obstacles: [], surfaces: MESH, walk }, { sweepId: "photo" }, item);
    if (plan.status !== "OK") throw new Error(plan.status);
    expect(plan.standPoint.y).toBeGreaterThan(3.4);
    // The walked line goes around the shelf, not through it.
    for (let i = 0; i < plan.polyline.length - 1; i++) expect(segmentWalkable(walk, plan.polyline[i], plan.polyline[i + 1], 0.2)).toBe(true);
  });
});
