import { describe, expect, it } from "vitest";
import { fixtureLayers } from "@/lib/costar/fixture";
import { astar, buildGraph } from "@/lib/routing/astar";
import { sweepsToGraph, type TwinSweep } from "@/lib/twin/sweepsToGraph";

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
});
