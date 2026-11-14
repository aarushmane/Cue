import { describe, expect, it } from "vitest";
import { fixtureLayers } from "@/lib/costar/fixture";
import { astar, buildGraph } from "@/lib/routing/astar";
import { segmentsCross, sweepsToGraph, type TwinSweep, type WallSegment } from "@/lib/twin/sweepsToGraph";

describe("sweepsToGraph", () => {
  it("turns fixture Matterport sweeps into a connected draft graph using neighbor data", async () => {
    const twin = (await fixtureLayers.getTwin("fixture-model-1"))!;
    const g = sweepsToGraph(twin.sweeps, { floorId: "floor-1", entranceSweepId: "sw-00" });
    expect(g.edgeSource).toBe("neighbors");
    expect(g.nodes).toHaveLength(twin.sweeps.length);
    expect(g.components).toHaveLength(1);
    expect(g.nodes.find((n) => n.sweepId === "sw-00")?.kind).toBe("entrance");
    for (const n of g.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(1);
      expect(n.source).toBe("matterport");
    }
    // The draft is routable with the same A* used for shoppers, and weights never undercut real distance.
    const graph = buildGraph(g.nodes, g.edges, g.widthM, g.heightM);
    const far = g.nodes.find((n) => n.sweepId === "sw-33")!.id;
    expect(astar(graph, g.nodes.find((n) => n.kind === "entrance")!.id, far)).not.toBeNull();
    for (const e of g.edges) expect(e.weight).toBeGreaterThanOrEqual(4);
  });

  it("infers edges by proximity when neighbors are missing, and warns", () => {
    const sweeps: TwinSweep[] = [0, 3, 6, 20].map((x, i) => ({ id: `s${i}`, x, y: 0, floorId: "f" }));
    const g = sweepsToGraph(sweeps, { floorId: "f", maxEdgeM: 4 });
    expect(g.edgeSource).toBe("proximity");
    expect(g.edges).toHaveLength(2); // s0–s1, s1–s2; s3 is 14 m away
    expect(g.components).toHaveLength(2);
    expect(g.warnings.join(" ")).toMatch(/disconnected/);
    expect(g.warnings.join(" ")).toMatch(/No entrance/);
  });

  it("drops edges that cross an obstacle such as a shelf", () => {
    const sweeps: TwinSweep[] = [
      { id: "a", x: 0, y: 0, floorId: "f", neighbors: ["b"] },
      { id: "b", x: 4, y: 0, floorId: "f", neighbors: ["a"] },
    ];
    const g = sweepsToGraph(sweeps, { floorId: "f", obstacles: [{ x: 1.5, y: -1, w: 1, h: 2 }] });
    expect(g.edges).toHaveLength(0);
    expect(g.warnings.join(" ")).toMatch(/cross a shelf/);
  });

  it("ignores other floors", () => {
    const g = sweepsToGraph([{ id: "a", x: 0, y: 0, floorId: "f2" }], { floorId: "f1" });
    expect(g.nodes).toHaveLength(0);
  });

  describe("L-shaped store with a doorway (proximity fallback)", () => {
    // Room A is the long bar (x 0–12, y 0–6); room B is the leg below it (x 0–6, y 6–14).
    // They share the wall y = 6, x 0–6, with a doorway gap at x 2.5–3.5. y grows downward, as on the plan.
    const walls: WallSegment[] = [
      { ax: 0, ay: 6, bx: 2.5, by: 6 }, // shared wall, left of the door
      { ax: 3.5, ay: 6, bx: 6, by: 6 }, // shared wall, right of the door
      { ax: 0, ay: 0, bx: 12, by: 0 }, // outer walls
      { ax: 12, ay: 0, bx: 12, by: 6 },
      { ax: 12, ay: 6, bx: 6, by: 6 },
      { ax: 6, ay: 6, bx: 6, by: 14 },
      { ax: 6, ay: 14, bx: 0, by: 14 },
      { ax: 0, ay: 14, bx: 0, by: 0 },
    ];
    const roomA: TwinSweep[] = [1, 3, 5, 7, 9, 11].flatMap((x) => [2, 4].map((y) => ({ id: `a-${x}-${y}`, x, y, floorId: "f" })));
    // B's top-left sweep sits 0.8 m below the wall, so the closest A–B pair (2.8 m, within maxEdgeM) goes straight
    // through the wall and must be dropped; the only legal crossing is the 4.5 m pair through the doorway.
    const roomB: TwinSweep[] = [1, 3, 5].flatMap((x) =>
      [8.5, 10.5, 12.5].map((y) => ({ id: `b-${x}-${y}`, x, y: x === 1 && y === 8.5 ? 6.8 : y, floorId: "f" })),
    );
    const sweeps = [...roomA, ...roomB];
    const g = sweepsToGraph(sweeps, { floorId: "f", walls, maxEdgeM: 3, entranceSweepId: "a-11-2" });
    const sweepOf = new Map(g.nodes.map((n) => [n.id, sweeps.find((s) => s.id === n.sweepId)!]));

    it("comes out as one component", () => {
      expect(g.edgeSource).toBe("proximity");
      expect(g.components).toHaveLength(1);
      expect(g.metrics.componentsBeforeBridging).toBe(2);
      expect(g.metrics.components).toBe(1);
      expect(g.metrics.componentSizes).toEqual([sweeps.length]);
      expect(g.warnings.join(" ")).not.toMatch(/disconnected/);
    });

    it("bridges once, through the doorway, and never crosses a wall", () => {
      expect(g.metrics.bridges).toHaveLength(1);
      const [bridge] = g.metrics.bridges;
      expect(new Set([sweepOf.get(bridge.from)!.id, sweepOf.get(bridge.to)!.id])).toEqual(new Set(["a-3-4", "b-3-8.5"]));
      expect(bridge.lengthM).toBe(4.5);
      expect(g.warnings.some((w) => w.includes(bridge.edgeId) && /check it is a real walkway/.test(w))).toBe(true);
      for (const e of g.edges) {
        const a = sweepOf.get(e.from)!;
        const b = sweepOf.get(e.to)!;
        for (const w of walls) expect(segmentsCross(a.x, a.y, b.x, b.y, w)).toBe(false);
      }
    });

    it("reports edge lengths, degrees and wall drops", () => {
      const histTotal = g.metrics.edgeLengthHistogram.reduce((n, b) => n + b.count, 0);
      expect(histTotal).toBe(g.edges.length);
      expect(g.metrics.edgeLengthHistogram.find((b) => b.fromM === 4)!.count).toBe(1); // the 4.5 m bridge
      const degTotal = g.metrics.degreeDistribution.reduce((n, d) => n + d.count, 0);
      expect(degTotal).toBe(sweeps.length);
      expect(g.metrics.degreeDistribution.find((d) => d.degree === 0)).toBeUndefined();
      // (1,4)–(1,6.8) is the only pair within maxEdgeM that crosses the wall.
      expect(g.metrics.edgesDroppedByWalls).toBe(1);
    });
  });

  it("does not bridge gaps of 2×maxEdgeM or more, or when sweeps have neighbor links", () => {
    const far = sweepsToGraph([0, 3, 6, 14].map((x, i) => ({ id: `s${i}`, x, y: 0, floorId: "f" })), { floorId: "f", maxEdgeM: 4 });
    expect(far.metrics.bridges).toHaveLength(0); // 8 m gap is not under 8 m
    expect(far.components).toHaveLength(2);

    const near = sweepsToGraph([0, 3, 6, 13].map((x, i) => ({ id: `s${i}`, x, y: 0, floorId: "f" })), { floorId: "f", maxEdgeM: 4 });
    expect(near.metrics.bridges).toHaveLength(1);
    expect(near.components).toHaveLength(1);

    const linked = sweepsToGraph(
      [
        { id: "a", x: 0, y: 0, floorId: "f", neighbors: ["b"] },
        { id: "b", x: 3, y: 0, floorId: "f", neighbors: ["a"] },
        { id: "c", x: 9, y: 0, floorId: "f", neighbors: [] },
      ],
      { floorId: "f", maxEdgeM: 4 },
    );
    expect(linked.metrics.bridges).toHaveLength(0);
    expect(linked.components).toHaveLength(2);
  });
});
