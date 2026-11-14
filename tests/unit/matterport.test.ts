import { describe, expect, it } from "vitest";
import { mapTwin, type RawTwin } from "@/lib/costar/matterport";
import { parseCsv } from "@/lib/costar/modelsIndex";
import { squareWkt } from "@/lib/costar/vexcel";
import { segmentsCross, sweepsToGraph } from "@/lib/twin/sweepsToGraph";

// Shapes copied from the track quickstart's real (trimmed) responses.
const floors: RawTwin["floors"] = [{
  id: "f1", label: "Floor 1",
  vertices: [{ id: "a", position: { x: 2, y: -10 } }, { id: "b", position: { x: 2, y: 10 } }, { id: "c", position: { x: 9, y: 0 } }, { id: "d", position: { x: 9, y: 1 } }],
  edges: [{ id: "w1", type: "wall", vertices: [{ id: "a" }, { id: "b" }] }, { id: "o1", type: "door", vertices: [{ id: "c" }, { id: "d" }] }],
}];
const plans = { floorplans: [
  { format: "jpg", flags: ["photogramy"], url: "https://cdn-2.matterport.com/plan.jpg", width: 1903, height: 1289, resolution: 100, origin: { x: -13.781, y: -7.021 }, floor: { id: "f1" } },
  { format: "jpg", flags: ["photogramy", "colored_rooms"], url: "https://cdn-2.matterport.com/rooms.jpg", resolution: 100, origin: { x: 0, y: 0 } },
] };
const sky = (n: string) => ({ children: [0, 1, 2, 3, 4, 5].map((i) => `https://cdn-2.matterport.com/${n}_skybox${i}.jpg`) });

describe("mapTwin", () => {
  it("maps anchor locations with neighbors, floors, rooms; flips y; keeps only wall-type edges", () => {
    const t = mapTwin("m1", {
      floors,
      assets: plans,
      locations: [
        { id: "L1", position: { x: 0, y: 3, z: 1.5 }, neighbors: ["L2", "ghost"], floor: { id: "f1" }, room: { id: "r1", classifications: [{ label: "Lobby" }] }, pano: { id: "p1", label: "1", skybox: sky("p1") } },
        { id: "L2", position: { x: 1, y: 3, z: 1.5 }, neighbors: ["L1"], floor: { id: "f1" } },
      ],
    });
    expect(t.sweeps).toEqual([
      { id: "L1", x: 0, y: -3, floorId: "f1", neighbors: ["L2"], label: "the lobby" },
      { id: "L2", x: 1, y: -3, floorId: "f1", neighbors: ["L1"], label: undefined },
    ]);
    expect(t.rooms).toEqual({ L1: "Lobby" });
    expect(t.panoramas).toEqual([{ sweepId: "L1", imageUrl: "https://cdn-2.matterport.com/p1_skybox1.jpg" }]);
    expect(t.walls!.f1).toEqual([{ ax: 2, ay: 10, bx: 2, by: -10 }]);
    expect(t.floorPlans).toHaveLength(1);
    expect(t.floorPlans![0].floorId).toBe("f1");
    expect(t.floorPlanImageUrl).toBe("https://cdn-2.matterport.com/plan.jpg");
  });

  it("falls back to pano positions and assigns floors by height", () => {
    const t = mapTwin("m2", {
      floors: [{ id: "g", label: "Ground" }, { id: "u", label: "Upper" }],
      panoLocations: [
        { id: "p1", position: { x: 0, y: 0, z: 1.5 }, skybox: sky("p1") },
        { id: "p2", position: { x: 3, y: 0, z: 1.4 } },
        { id: "p3", position: { x: 0, y: 0, z: 4.6 } },
      ],
    });
    expect(t.sweeps.map((s) => [s.id, s.floorId, s.neighbors])).toEqual([["p1", "g", undefined], ["p2", "g", undefined], ["p3", "u", undefined]]);
  });
});

describe("walls in the twin import", () => {
  it("detects proper crossings only", () => {
    const w = { ax: 0, ay: -5, bx: 0, by: 5 };
    expect(segmentsCross(-1, 0, 1, 0, w)).toBe(true);
    expect(segmentsCross(1, 0, 2, 0, w)).toBe(false);
    expect(segmentsCross(0, 5, 1, 6, w)).toBe(false); // touches the end point
  });

  it("drops proximity edges through walls but trusts Matterport neighbor links", () => {
    const wall = [{ ax: 1.5, ay: -10, bx: 1.5, by: 10 }];
    const prox = sweepsToGraph(
      [{ id: "a", x: 0, y: 0, floorId: "f" }, { id: "b", x: 3, y: 0, floorId: "f" }, { id: "c", x: 0, y: 3, floorId: "f" }],
      { floorId: "f", walls: wall, entranceSweepId: "a" },
    );
    expect(prox.edges).toHaveLength(1); // a–c only; a–b and b–c cross the wall
    expect(prox.components).toHaveLength(2);

    const nb = sweepsToGraph(
      [{ id: "a", x: 0, y: 0, floorId: "f", neighbors: ["b"] }, { id: "b", x: 3, y: 0, floorId: "f", neighbors: ["a"] }],
      { floorId: "f", walls: wall, entranceSweepId: "a" },
    );
    expect(nb.edges).toHaveLength(1);
    expect(nb.edgeSource).toBe("neighbors");
  });
});

describe("helpers", () => {
  it("parses quoted CSV fields", () => {
    expect(parseCsv('sid,address,n\r\nx1,"337 S Broadway, Los Angeles",3\ny2,"say ""hi""",4\n')).toEqual([
      ["sid", "address", "n"], ["x1", "337 S Broadway, Los Angeles", "3"], ["y2", 'say "hi"', "4"],
    ]);
  });
  it("builds a closed lon-lat WKT square", () => {
    const wkt = squareWkt(34.0934917, -118.3171, 70);
    expect(wkt.startsWith("POLYGON((-118.3178")).toBe(true);
    const pts = wkt.slice(9, -2).split(",");
    expect(pts[0]).toBe(pts[4]);
  });
});
