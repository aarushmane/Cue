import { describe, expect, it } from "vitest";
import { newRun } from "@/lib/agents/onboarding/run-context";
import { extractPlan, placePlan, planForFloor, runView, stripDataUrls } from "@/lib/agents/onboarding/view";
import { sweepsToGraph } from "@/lib/twin/sweepsToGraph";
import type { DataLayers } from "@/lib/costar";

const layers = { source: "fixture" } as DataLayers;

describe("placePlan", () => {
  it("maps a bottom-left-origin plan into the graph's y-down normalized frame", () => {
    // Plan: 200×100 px at 10 px/m → 20×10 m, origin (0, 0) world. Y-down it spans x 0..20, y -10..0.
    const g = { originX: 0, originY: -10, widthM: 20, heightM: 10 };
    expect(placePlan({ url: "u", width: 200, height: 100, resolution: 10, originX: 0, originY: 0 }, g)).toEqual({ url: "u", x: 0, y: 0, w: 1, h: 1 });
    // Graph padded by 2 m on each side → plan sits inside.
    const padded = { originX: -2, originY: -12, widthM: 24, heightM: 14 };
    const p = placePlan({ url: "u", width: 200, height: 100, resolution: 10, originX: 0, originY: 0 }, padded)!;
    expect(p.x).toBeCloseTo(2 / 24);
    expect(p.y).toBeCloseTo(2 / 14);
    expect(p.w).toBeCloseTo(20 / 24);
    expect(p.h).toBeCloseTo(10 / 14);
  });

  it("puts image row 0 at world y = originY + H/res (top) and keeps it upright, for a non-zero origin", () => {
    // 300×200 px at 20 px/m → 15×10 m, bottom-left at world (3, 4). World extent: x 3..18, y 4..14 (y up).
    const plan = { url: "u", width: 300, height: 200, resolution: 20, originX: 3, originY: 4 };
    const g = { originX: -2, originY: -20, widthM: 25, heightM: 20 }; // y-down frame x -2..23, y -20..0
    const p = placePlan(plan, g)!;
    // Pixel (u, r) → world (originX + u/res, originY + (H - r)/res) → y-down → normalized. Must equal the box's interpolation.
    const px = (u: number, r: number) => ({ x: (plan.originX + u / 20 - g.originX) / g.widthM, y: (-(plan.originY + (200 - r) / 20) - g.originY) / g.heightM });
    for (const [u, r] of [[0, 0], [300, 0], [0, 200], [300, 200], [75, 50]]) {
      const want = px(u, r);
      expect(p.x + (u / 300) * p.w).toBeCloseTo(want.x);
      expect(p.y + (r / 200) * p.h).toBeCloseTo(want.y);
    }
    // Top-left corner = world (3, 14) → y-down (3, -14).
    expect(p.x).toBeCloseTo(5 / 25);
    expect(p.y).toBeCloseTo(6 / 20);
  });

  it("returns null without a scale", () => {
    expect(placePlan({ url: "u", width: 0, height: 0, resolution: 0, originX: 0, originY: 0 }, { originX: 0, originY: 0, widthM: 1, heightM: 1 })).toBeNull();
  });
});

describe("runView", () => {
  it("is empty before the agent builds anything", () => {
    expect(runView(newRun("r", layers))).toEqual({ property: null, graph: null, candidates: [], aerial: null });
  });

  it("exposes graph geometry, landmarks and the matching floor's plan", () => {
    const run = newRun("r", layers);
    const sweeps = [
      { id: "a", x: 0, y: 0, floorId: "f2", neighbors: ["b"] },
      { id: "b", x: 5, y: 0, floorId: "f2", neighbors: ["a", "c"] },
      { id: "c", x: 5, y: 5, floorId: "f2", neighbors: ["b"] },
    ];
    run.twin = {
      modelId: "m", floors: [{ id: "f1", label: "Ground" }, { id: "f2", label: "Upper" }], sweeps, panoramas: [], floorPlanImageUrl: null,
      // Deliberately not in floor order: plans are matched by Floorplan.floor, not by position.
      floorPlans: [
        { url: "upper.jpg", width: 100, height: 100, resolution: 10, originX: 0, originY: 0, floorId: "f2" },
        { url: "ground.jpg", width: 100, height: 100, resolution: 10, originX: 0, originY: 0, floorId: "f1" },
      ],
      walls: { f2: [{ ax: 0, ay: 0, bx: 5, by: 5 }] },
    };
    run.graph = sweepsToGraph(sweeps, { floorId: "f2", entranceSweepId: "a" });
    run.graphFloorId = "f2";
    run.landmarkSweepIds = ["c"];
    const v = runView(run).graph!;
    expect(v.floor_label).toBe("Upper");
    expect(v.plan?.url).toBe("upper.jpg");
    expect(v.nodes).toHaveLength(3);
    expect(v.edges).toHaveLength(2);
    expect(v.nodes.filter((n) => n.landmark)).toHaveLength(1);
    expect(v.nodes.find((n) => n.kind === "entrance")).toBeTruthy();
    // Dev debug payload (NODE_ENV is "test"): walls in the same normalized frame as the nodes.
    const a = v.nodes.find((n) => n.kind === "entrance")!;
    expect(v.debug?.plan?.matchedBy).toBe("floor-id");
    expect(v.debug?.walls[0].x1).toBeCloseTo(a.x);
    expect(v.debug?.walls[0].y1).toBeCloseTo(a.y);
  });
});

describe("runView aerial", () => {
  it("passes inspect_aerial's notes through for the Approach section", () => {
    const run = newRun("r", layers);
    run.aerialNotes = "  Vexcel orthophoto, north up. Entrance likely faces south (medium). Parking: lot to the west.  ";
    expect(runView(run).aerial).toEqual({ notes: "Vexcel orthophoto, north up. Entrance likely faces south (medium). Parking: lot to the west." });
  });

  it("is null when the agent never inspected the aerial view, or got nothing back", () => {
    expect(runView(newRun("r", layers)).aerial).toBeNull();
    const run = newRun("r", layers);
    run.aerialNotes = "  ";
    expect(runView(run).aerial).toBeNull();
  });

  it("never carries an image data URL, even if one ends up in the notes", () => {
    const run = newRun("r", layers);
    run.aerialNotes = "Photo: data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ== Entrance faces east.";
    const v = runView(run);
    expect(v.aerial?.notes).toBe("Photo: [image omitted] Entrance faces east.");
    expect(JSON.stringify(v)).not.toMatch(/data:image|base64/);
  });
});

describe("stripDataUrls", () => {
  it("removes data URLs of any media type and leaves ordinary text and https links alone", () => {
    expect(stripDataUrls("a data:image/png;base64,iVBOR= b")).toBe("a [image omitted] b");
    expect(stripDataUrls('("data:application/octet-stream,abc")')).toBe('("[image omitted]")');
    expect(stripDataUrls("Metadata: none. See https://example.com/a.jpg")).toBe("Metadata: none. See https://example.com/a.jpg");
  });
});

describe("planForFloor", () => {
  const p = (url: string, floorId?: string | null) => ({ url, width: 10, height: 10, resolution: 1, originX: 0, originY: 0, floorId });
  it("matches by floor id regardless of order", () => {
    expect(planForFloor([p("b", "f2"), p("a", "f1")], 2, "f1")?.plan.url).toBe("a");
  });
  it("falls back to an all-floors plan, never another floor's plan", () => {
    expect(planForFloor([p("b", "f2"), p("all", null)], 2, "f1")).toEqual({ plan: p("all", null), matchedBy: "all-floors" });
    expect(planForFloor([p("b", "f2")], 2, "f1")).toBeNull();
  });
  it("uses the only plan of a single-floor model", () => {
    expect(planForFloor([p("x", "other")], 1, "floor-1")?.matchedBy).toBe("single-floor");
  });
});

describe("extractPlan", () => {
  const t1 = [{ content: "Look up property", status: "in_progress" }];
  const t2 = [{ content: "Look up property", status: "completed" }];
  const messages = [{ tool_calls: [{ name: "write_todos", args: { todos: t1 } }] }, { content: "x" }, { tool_calls: [{ name: "lookup_property" }, { name: "write_todos", args: { todos: t2 } }] }];

  it("prefers state.todos", () => {
    expect(extractPlan({ messages, todos: [{ content: "s", status: "pending" }] }).todos).toEqual([{ content: "s", status: "pending" }]);
  });
  it("falls back to the last write_todos call", () => {
    const r = extractPlan({ messages, todos: [] });
    expect(r.todos).toEqual(t2);
    expect(r.toolCalls).toEqual(["write_todos", "lookup_property", "write_todos"]);
  });
  it("handles no plan", () => {
    expect(extractPlan({})).toEqual({ toolCalls: [], todos: [] });
  });
});
