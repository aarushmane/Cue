import { describe, expect, it } from "vitest";
import type { GraphView } from "@/lib/agents/onboarding/view";
import { Plan } from "@/lib/demo/schemas";
import { draftToFloorPlan } from "@/lib/map/draftToFloorPlan";
import { mapChecks } from "@/lib/map/graph";

const base = { mapId: "map-demo", version: 3 };

function view(over: Partial<GraphView> = {}): GraphView {
  return {
    floor_id: "f0", floor_label: "Ground floor", width_m: 40, height_m: 20, edge_source: "neighbors", components: 1, by_agent: true,
    nodes: [
      { id: "sweep-aaaaaaaaaaaaaaaaaaaaaaaaaaaa", x: 0, y: 0.5, kind: "entrance", label: "Entrance", landmark: false },
      { id: "sweep-b", x: 0.5, y: 0.5, kind: "junction", label: "Bakery counter", landmark: true },
      { id: "sweep-c", x: 1, y: 1, kind: "junction", label: "", landmark: false },
    ],
    edges: [["sweep-aaaaaaaaaaaaaaaaaaaaaaaaaaaa", "sweep-b"], ["sweep-b", "sweep-aaaaaaaaaaaaaaaaaaaaaaaaaaaa"], ["sweep-b", "sweep-c"], ["sweep-c", "sweep-c"], ["sweep-c", "missing"]],
    plan: null,
    ...over,
  };
}

describe("draftToFloorPlan", () => {
  it("keeps the graph frame without a plan image, with short unique ids and clean edges", () => {
    const { plan } = draftToFloorPlan(view(), base);
    expect(plan.mapId).toBe("map-demo");
    expect(plan.version).toBe(3);
    expect(plan.plan).toBeNull();
    expect(plan.aspect).toBe(2);
    expect(plan.nodes).toEqual([
      { id: "p1", x: 0, y: 0.5, kind: "entrance" },
      { id: "p2", x: 0.5, y: 0.5, kind: "junction" },
      { id: "p3", x: 1, y: 1, kind: "junction" },
    ]);
    expect(plan.edges).toEqual([["p1", "p2"], ["p2", "p3"]]);
    expect(plan.shelves).toEqual([]);
    expect(plan.landmarks).toEqual([{ id: "L1", x: 0.5, y: 0.5, label: "Bakery counter", verified: false }]);
    expect(Plan.safeParse(plan).success).toBe(true);
  });

  it("re-frames points into the floor plan image so they stay aligned with the stretched background", () => {
    // The image covers graph x -0.25..1.25 (60 m) and y -0.5..1.5 (40 m).
    const { plan, notes } = draftToFloorPlan(view({ plan: { url: "https://cdn.example.com/plan.png", x: -0.25, y: -0.5, w: 1.5, h: 2 } }), base);
    expect(plan.plan).toEqual({ url: "https://cdn.example.com/plan.png", name: "Matterport floor plan · Ground floor", kind: "image" });
    expect(plan.aspect).toBeCloseTo((1.5 * 40) / (2 * 20)); // 60 m × 40 m
    expect(plan.nodes.map((n) => [n.x, n.y])).toEqual([[0.1667, 0.5], [0.5, 0.5], [0.8333, 0.75]]);
    expect(plan.landmarks[0]).toMatchObject({ x: 0.5, y: 0.5 });
    expect(notes.some((n) => n.includes("outside"))).toBe(false);
  });

  it("clamps points outside the image and says how many", () => {
    const { plan, notes } = draftToFloorPlan(view({ plan: { url: "https://cdn.example.com/p.png", x: 0.2, y: 0, w: 0.6, h: 1 } }), base);
    expect(plan.nodes.map((n) => n.x)).toEqual([0, 0.5, 1]);
    expect(notes).toContain("2 points were outside the floor plan image and moved to its edge.");
  });

  it("drops unusable plan links and maps outdoor points to walk points", () => {
    const v = view({ plan: { url: "javascript:alert(1)", x: 0, y: 0, w: 1, h: 1 } });
    v.nodes[2] = { ...v.nodes[2], kind: "outdoor" };
    const { plan, notes } = draftToFloorPlan(v, base);
    expect(plan.plan).toBeNull();
    expect(plan.nodes[2].kind).toBe("walk");
    expect(notes.join(" ")).toMatch(/couldn't be used as the background/);
    expect(notes.join(" ")).toMatch(/1 outdoor point is imported as walk points/);
    expect(Plan.safeParse(plan).success).toBe(true);
  });

  it("leaves the publish checklist to gate the draft (no shelves yet)", () => {
    const { plan } = draftToFloorPlan(view(), base);
    const checks = mapChecks(plan, [{ location: { shelfId: "A1-S1", level: "middle" } as never }]);
    expect(checks.find((c) => c.label === "At least one entrance labeled")?.ok).toBe(true);
    expect(checks.find((c) => c.label === "Every shelf with verified products is placed")?.ok).toBe(false);
  });
});
