import { describe, expect, it } from "vitest";
import { headingDeg, segmentBlocked, triangulate, v3 } from "@/lib/wayfinding/geometry";
import { detectionRay, findItem, locateFromDetections } from "@/lib/wayfinding/locate";
import { planRouteToItem, sideOf } from "@/lib/wayfinding/plan";
import { edgeIndicator, lookAhead, progressAlong, projectArrows, projectPolyline, type Projector } from "@/lib/wayfinding/screen";
import type { Obstacle, SceneItem, Waypoint, WayfindingScene } from "@/lib/wayfinding/types";

// A 12 m × 8 m store (model frame, z up). One shelf block runs along x in the middle (x 2..10, y 3.5..4.5), so the
// front aisle (y≈2) and back aisle (y≈6) only connect around its ends. Scan points sit in both aisles.
const SHELF: Obstacle = { kind: "box", id: "shelf-A", label: "Aisle A", minX: 2, minY: 3.5, maxX: 10, maxY: 4.5 };
const WALL: Obstacle = { kind: "wall", ax: 0, ay: 8, bx: 12, by: 8 };
const wp = (id: string, x: number, y: number, neighbors: string[]): Waypoint => ({
  id, position: v3(x, y, 0), camera: v3(x, y, 1.35), rotation: { x: 0, y: 0, z: 0, w: 1 }, floorId: "f1", neighbors,
});
const WAYPOINTS: Waypoint[] = [
  wp("f0", 1, 2, ["f1", "e0"]), wp("f1", 4, 2, ["f0", "f2"]), wp("f2", 7, 2, ["f1", "f3"]), wp("f3", 10.8, 2, ["f2", "e1"]),
  wp("e0", 1, 6, ["f0", "b1"]), wp("b1", 4, 6, ["e0", "b2"]), wp("b2", 7, 6, ["b1", "e1"]), wp("e1", 10.8, 6, ["b2", "f3"]),
];
// Chips on the back face of the shelf, facing the back aisle.
const CHIPS: SceneItem = { id: "chips", name: "Potato chips", aliases: ["crisps"], category: "snacks", position: v3(6.5, 4.5, 1), source: "staff" };
const SODA: SceneItem = { id: "soda", name: "Cola", category: "drinks", position: v3(4, 3.5, 1.2), source: "staff" };
const scene = (over: Partial<WayfindingScene> = {}): WayfindingScene => ({
  modelId: "test", waypoints: WAYPOINTS, items: [CHIPS, SODA], obstacles: [SHELF, WALL], ...over,
});

describe("finding items by name", () => {
  it("matches the visitor's words, aliases and category", () => {
    expect(findItem("where are the chips", [CHIPS, SODA])).toEqual({ status: "MATCH", item: CHIPS });
    expect(findItem("crisps", [CHIPS, SODA])).toMatchObject({ status: "MATCH", item: { id: "chips" } });
    expect(findItem("toothpaste", [CHIPS, SODA]).status).toBe("NO_MATCH");
  });
  it("never guesses between equally good matches", () => {
    const bbq = { ...CHIPS, id: "bbq", name: "BBQ chips" };
    const salt = { ...CHIPS, id: "salt", name: "Salted chips" };
    expect(findItem("chips", [bbq, salt]).status).toBe("AMBIGUOUS");
  });
});

describe("locating items from photo detections", () => {
  it("turns skybox pixels into rays using Matterport's face convention", () => {
    const w = WAYPOINTS[0];
    const dir = (face: number, u = 0.5, v = 0.5) => detectionRay(w, { sweepId: w.id, face, u, v })!.dir;
    expect(dir(1)).toMatchObject({ x: 1, y: 0, z: 0 });
    expect(dir(2).y).toBeCloseTo(-1);
    expect(dir(3).x).toBeCloseTo(-1);
    expect(dir(4).y).toBeCloseTo(1);
    expect(dir(0).z).toBeCloseTo(1);
    expect(dir(5).z).toBeCloseTo(-1);
    // Right edge of face 1 leans toward face 2 (−y); top edge leans up.
    expect(dir(1, 1, 0.5).y).toBeLessThan(0);
    expect(dir(1, 0.5, 0).z).toBeGreaterThan(0);
  });
  it("applies the pano rotation", () => {
    const turned: Waypoint = { ...WAYPOINTS[0], rotation: { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 } }; // +90° about z
    const d = detectionRay(turned, { sweepId: turned.id, face: 1, u: 0.5, v: 0.5 })!.dir;
    expect(d.x).toBeCloseTo(0);
    expect(d.y).toBeCloseTo(1);
  });
  it("triangulates rays from two sweeps", () => {
    const target = v3(6.5, 4.5, 1);
    const ray = (o: ReturnType<typeof v3>) => ({ origin: o, dir: v3(target.x - o.x, target.y - o.y, target.z - o.z) });
    const t = triangulate([ray(v3(4, 6, 1.35)), ray(v3(7, 6, 1.35))])!;
    expect(t.point.x).toBeCloseTo(6.5);
    expect(t.point.y).toBeCloseTo(4.5);
    expect(t.point.z).toBeCloseTo(1);
    expect(t.residualM).toBeLessThan(1e-6);
  });
  it("locates from bearings seen at two sweeps", () => {
    const bearing = (w: Waypoint) => {
      const c = w.camera!;
      return { sweepId: w.id, headingDeg: headingDeg(c, CHIPS.position), elevationDeg: (Math.atan2(CHIPS.position.z - c.z, Math.hypot(CHIPS.position.x - c.x, CHIPS.position.y - c.y)) * 180) / Math.PI };
    };
    const r = locateFromDetections(WAYPOINTS, [bearing(WAYPOINTS[5]), bearing(WAYPOINTS[6])]);
    expect(r.status).toBe("OK");
    if (r.status !== "OK") return;
    expect(r.method).toBe("triangulated");
    expect(r.position.x).toBeCloseTo(6.5, 1);
    expect(r.position.y).toBeCloseTo(4.5, 1);
    expect(r.confidence).toBeGreaterThan(0.5);
  });
  it("falls back to the first shelf a single ray hits", () => {
    // From b2 (7, 6) looking straight at −y, slightly down: hits the shelf's back face at y = 4.5.
    const r = locateFromDetections(WAYPOINTS, [{ sweepId: "b2", headingDeg: -90, elevationDeg: -10 }], [SHELF]);
    expect(r).toMatchObject({ status: "OK", method: "ray_to_fixture" });
    if (r.status === "OK") expect(r.position.y).toBeCloseTo(4.5);
  });
  it("refuses to invent a distance from one ray with nothing to hit", () => {
    expect(locateFromDetections(WAYPOINTS, [{ sweepId: "b2", headingDeg: 90, elevationDeg: 0 }]).status).toBe("INSUFFICIENT");
  });
});

describe("planning a route to an item", () => {
  it("walks around the shelf to the side the item faces", () => {
    const plan = planRouteToItem(scene(), { sweepId: "f1" }, CHIPS);
    expect(plan.status).toBe("OK");
    if (plan.status !== "OK") return;
    expect(plan.waypointIds[0]).toBe("f1");
    expect(plan.waypointIds.at(-1)).toBe("b2"); // closest back-aisle point to the chips
    // Never through the shelf.
    for (let i = 0; i < plan.polyline.length - 1; i++) expect(segmentBlocked(plan.polyline[i], plan.polyline[i + 1], SHELF)).toBe(false);
    for (const a of plan.arrows) expect(a.position.x > 2 && a.position.x < 10 && a.position.y > 3.5 && a.position.y < 4.5).toBe(false);
    expect(plan.arrows.length).toBeGreaterThan(5);
    expect(plan.legs.at(-1)!.text).toMatch(/^Potato chips is/);
    expect(plan.totalDistanceM).toBeGreaterThan(8);
  });
  it("stands where the item is visible and faces it", () => {
    const plan = planRouteToItem(scene(), { sweepId: "e0" }, CHIPS);
    if (plan.status !== "OK") throw new Error(plan.status);
    expect(plan.waypointIds.at(-1)).toBe("b2"); // nearest back-aisle point to x = 6.5
    expect(plan.facingDeg).toBeLessThan(-80); // facing −y, toward the shelf
  });
  it("reports ALREADY_THERE at the best stand point", () => {
    const here = planRouteToItem(scene(), { sweepId: "b2" }, CHIPS);
    expect(here.status).toBe("ALREADY_THERE");
    if (here.status === "ALREADY_THERE") expect(here.legs[0].text).toBe("Potato chips is about 2 steps from here.");
  });
  it("routes from a free position near the scan points", () => {
    const plan = planRouteToItem(scene(), { position: v3(5.5, 1.5, 0), floorId: "f1" }, SODA);
    expect(plan.status).toBe("OK");
    if (plan.status === "OK") expect(plan.waypointIds.at(-1)).toBe("f1");
  });
  it("rejects a start that is not near any reachable scan point", () => {
    expect(planRouteToItem(scene(), { position: v3(40, 40, 0) }, CHIPS).status).toBe("START_INVALID");
    expect(planRouteToItem(scene(), { sweepId: "nope" }, CHIPS).status).toBe("START_INVALID");
  });
  it("treats an item inside its shelf (face unknown) as visible from either aisle, with a warning", () => {
    const inside = { ...CHIPS, position: v3(6.5, 4, 1) };
    const plan = planRouteToItem(scene(), { sweepId: "f1" }, inside);
    expect(plan.status).toBe("OK");
    if (plan.status === "OK") expect(plan.warnings.join(" ")).toMatch(/inside its shelf/);
  });
  it("finds no approach when walls hide the item from every scan point", () => {
    const boxedIn: Obstacle[] = [SHELF, { kind: "wall", ax: 0, ay: 5, bx: 12, by: 5 }];
    expect(planRouteToItem(scene({ obstacles: boxedIn }), { sweepId: "f1" }, CHIPS).status).toBe("NO_APPROACH");
  });
  it("infers links without neighbour data, but never through obstacles", () => {
    const bare = WAYPOINTS.map((w) => ({ ...w, neighbors: [] }));
    const plan = planRouteToItem(scene({ waypoints: bare }), { sweepId: "f1" }, CHIPS);
    if (plan.status !== "OK") throw new Error(plan.status);
    expect(plan.warnings.join(" ")).toMatch(/inferred/);
    for (let i = 0; i < plan.polyline.length - 1; i++) expect(segmentBlocked(plan.polyline[i], plan.polyline[i + 1], SHELF)).toBe(false);
  });
  it("smoothing never cuts a corner through an obstacle", () => {
    const smooth = planRouteToItem(scene(), { sweepId: "f2" }, CHIPS, { smooth: true });
    const raw = planRouteToItem(scene(), { sweepId: "f2" }, CHIPS, { smooth: false });
    if (smooth.status !== "OK" || raw.status !== "OK") throw new Error("expected routes");
    expect(smooth.polyline.length).toBeLessThanOrEqual(raw.polyline.length);
    for (let i = 0; i < smooth.polyline.length - 1; i++) expect(segmentBlocked(smooth.polyline[i], smooth.polyline[i + 1], SHELF, 0.3)).toBe(false);
    expect(smooth.waypointIds).toEqual(raw.waypointIds); // Showcase still steps through every scan point
  });
  it("keeps defaults when options arrive as undefined (unset API fields)", () => {
    const plan = planRouteToItem(scene(), { sweepId: "f1" }, CHIPS, { clearanceM: undefined, maxApproachM: undefined, arrowSpacingM: undefined, smooth: undefined });
    expect(plan.status).toBe("OK");
  });
  it("says which side the item is on", () => {
    expect(sideOf(0, v3(0, 0, 0), v3(0, 2, 0))).toBe("left"); // walking +x, item at +y
    expect(sideOf(0, v3(0, 0, 0), v3(0, -2, 0))).toBe("right");
    expect(sideOf(0, v3(0, 0, 0), v3(2, 0.2, 0))).toBe("ahead");
  });
});

describe("drawing the route on screen", () => {
  // Pinhole camera at (6, -4, 1.6) looking +y (z up): screen right = +x, screen down = −z.
  const W = 1000, H = 600, F = 500;
  const cam = v3(6, -4, 1.6);
  const project: Projector = (p) => {
    const dx = p.x - cam.x, depth = p.y - cam.y, dz = p.z - cam.z;
    if (depth <= 0.01) return { x: W / 2 - (F * dx) / Math.max(-depth, 0.01), y: H / 2 + (F * dz) / Math.max(-depth, 0.01), z: 2 };
    return { x: W / 2 + (F * dx) / depth, y: H / 2 - (F * dz) / depth, z: 0.5 };
  };

  it("tracks progress and looks ahead along the route", () => {
    const line = [v3(0, 0, 0), v3(10, 0, 0), v3(10, 5, 0)];
    expect(progressAlong(line, v3(4, 1, 0))).toMatchObject({ atM: 4, offRouteM: 1 });
    expect(lookAhead(line, v3(9, 0, 0), 3)).toMatchObject({ x: 10, y: 2 });
  });
  it("projects floor arrows as chevrons pointing along the route", () => {
    const plan = planRouteToItem(scene(), { sweepId: "f1" }, CHIPS);
    if (plan.status !== "OK") throw new Error(plan.status);
    const shown = projectArrows(plan.arrows, project, { w: W, h: H });
    expect(shown.length).toBeGreaterThan(0);
    // The shortest way round the shelf from f1 is west (−x) along the front aisle: those chevrons point left on screen.
    expect(plan.legs[0].headingDeg).toBe(180);
    const first = shown.find((a) => a.atM < 2)!;
    expect(Math.abs(first.angleRad)).toBeGreaterThan(Math.PI - 0.3);
    // Floor arrows render below the horizon.
    for (const a of shown) expect(a.y).toBeGreaterThan(H / 2);
  });
  it("splits the line where it goes behind the camera", () => {
    const runs = projectPolyline([v3(6, -6, 0), v3(6, 6, 0)], project);
    expect(runs).toHaveLength(1);
    expect(runs[0].length).toBeGreaterThan(5);
    // Cut at the camera plane, not at the last sample in front: the line runs off the bottom of the screen.
    expect(Math.max(...runs[0].map((p) => p.y))).toBeGreaterThan(H * 10);
  });
  it("points at off-screen and behind-camera targets from the screen edge", () => {
    expect(edgeIndicator(project(v3(6, 2, 1.6)), { w: W, h: H })).toBeNull();
    const right = edgeIndicator(project(v3(30, 2, 1.6)), { w: W, h: H })!;
    expect(right.x).toBeCloseTo(W - 40);
    const behindLeft = edgeIndicator(project(v3(8, -10, 1.6)), { w: W, h: H })!; // behind and to the right → mirrored
    expect(behindLeft.x).toBeGreaterThan(W / 2);
  });
});

describe("distances in steps", () => {
  it("rounds to whole steps of about 0.75 m", async () => {
    const { aboutSteps, stepsFor } = await import("@/lib/wayfinding/steps");
    expect(stepsFor(0.2)).toBe(1);
    expect(aboutSteps(0.6)).toBe("a step");
    expect(aboutSteps(3)).toBe("about 4 steps");
    expect(aboutSteps(5.6)).toBe("about 7 steps");
  });
});
