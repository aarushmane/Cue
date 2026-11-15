import { describe, expect, it } from "vitest";
import { demoFloorPlan, mapChecks, toStoreGraph } from "@/lib/map/graph";
import { editorId, graphPayload, tablesToFloorPlan } from "@/lib/staff/maps";
import { DEMO_EDGES, DEMO_LANDMARKS, DEMO_NODES, DEMO_SHELVES, DEMO_STORE } from "@/lib/seed/demo-store";

describe("Supabase map storage helpers", () => {
  it("strips only this map's namespace from materialized ids", () => {
    expect(editorId("m2", "m2:N01")).toBe("N01");
    expect(editorId("m2", "N01")).toBe("N01");
    expect(editorId("m2", "m20:N01")).toBe("m20:N01");
  });

  it("rebuilds the seeded map from its rows exactly as memory mode's demoFloorPlan", () => {
    const fp = tablesToFloorPlan(
      { id: "map-demo-v1", version: 1 }, { width_m: DEMO_STORE.widthM, height_m: DEMO_STORE.heightM },
      {
        nodes: DEMO_NODES.map((n) => ({ id: n.id, x: n.x, y: n.y, kind: n.kind })),
        edges: DEMO_EDGES.map((e) => ({ from_node: e.from, to_node: e.to })),
        shelves: DEMO_SHELVES.map((s) => ({ id: s.id, anchor_node: s.anchorNodeId, x: s.x, y: s.y, w: s.w, h: s.h })),
        landmarks: DEMO_LANDMARKS.map((l) => ({ id: l.id, node_id: l.nodeId, description: l.description, verified: true })),
      },
    );
    expect(fp).toEqual({ ...demoFloorPlan(), mapId: "map-demo-v1" });
  });

  it("reads back a published map's namespaced rows with editor ids", () => {
    const fp = tablesToFloorPlan({ id: "m2", version: 2 }, { width_m: 30, height_m: 15 }, {
      nodes: [{ id: "m2:a", x: 0, y: 0, kind: "entrance" }, { id: "m2:b", x: 1, y: 1, kind: "junction" }],
      edges: [{ from_node: "m2:a", to_node: "m2:b" }],
      shelves: [{ id: "S-A1-1", anchor_node: "m2:b", x: 0, y: 0, w: 0.1, h: 0.1 }],
      landmarks: [{ id: "m2:L1", node_id: "m2:a", description: "Banner", verified: null }, { id: "x", node_id: "gone", description: "?", verified: true }],
    });
    expect(fp.aspect).toBe(2);
    expect(fp.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(fp.edges).toEqual([["a", "b"]]);
    expect(fp.shelves[0].anchor).toBe("b");
    expect(fp.landmarks).toEqual([{ id: "L1", x: 0, y: 0, label: "Banner", verified: true }]);
  });

  it("builds the publish payload from the same StoreGraph memory mode routes on", () => {
    const draft = { ...demoFloorPlan(), nodes: demoFloorPlan().nodes.map((n) => (n.id === "N06" ? { ...n, kind: "walk" as const } : n)) };
    draft.landmarks = [
      { id: "L1", x: 0.08, y: 0.84, label: "Green banner", verified: true },
      { id: "L2", x: 0.5, y: 0.5, label: "Unchecked sign", verified: false },
    ];
    const { payload, unknownShelves } = graphPayload(draft, DEMO_STORE.id, 40);
    const g = toStoreGraph(draft, DEMO_STORE.id, 40);
    expect(unknownShelves).toEqual([]);
    expect(payload.nodes).toHaveLength(g.nodes.length);
    expect(payload.nodes.find((n) => n.id === "N06")?.kind).toBe("junction");
    expect(payload.edges[0]).toEqual({ id: g.edges[0].id, from: g.edges[0].from, to: g.edges[0].to, weight: g.edges[0].weight });
    expect(payload.shelves.find((s) => s.id === "S-A1-1")).toMatchObject({ aisle: "1", section: "1", anchor: "N09" });
    expect(payload.landmarks).toEqual([{ id: "L1", node: "N01", description: "Green banner" }]); // verified only, nearest point
    expect(payload.height_m).toBeCloseTo(40 / draft.aspect);
    expect(mapChecks(draft, []).every((c) => c.ok)).toBe(true);
  });

  it("reports placed shelf IDs the catalog doesn't know instead of dropping them silently", () => {
    const draft = demoFloorPlan();
    draft.shelves = [...draft.shelves, { key: "k", id: "S-ZZ-9", x: 0, y: 0, w: 0.1, h: 0.1, anchor: "N01" }];
    expect(graphPayload(draft, DEMO_STORE.id, 30).unknownShelves).toEqual(["S-ZZ-9"]);
  });
});
