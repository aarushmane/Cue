import { describe, expect, it } from "vitest";
import { newRun } from "@/lib/agents/onboarding/run-context";
import { extractPlan, placePlan, runView } from "@/lib/agents/onboarding/view";
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

  it("returns null without a scale", () => {
    expect(placePlan({ url: "u", width: 0, height: 0, resolution: 0, originX: 0, originY: 0 }, { originX: 0, originY: 0, widthM: 1, heightM: 1 })).toBeNull();
  });
});

describe("runView", () => {
  it("is empty before the agent builds anything", () => {
    expect(runView(newRun("r", layers))).toEqual({ property: null, graph: null, candidates: [] });
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
      floorPlans: [
        { url: "ground.jpg", width: 100, height: 100, resolution: 10, originX: 0, originY: 0 },
        { url: "upper.jpg", width: 100, height: 100, resolution: 10, originX: 0, originY: 0 },
      ],
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
