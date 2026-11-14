// Display model of an onboarding run for the staff screen: the draft graph in normalized coordinates, plus the
// floor plan image placed in the same frame when the twin has one. Pure, so it is unit tested.
import type { FloorPlanImage } from "../../costar";
import type { NodeKind } from "../../types";
import type { OnboardingRun } from "./run-context";

export interface GraphView {
  floor_id: string | null;
  floor_label: string | null;
  width_m: number;
  height_m: number;
  edge_source: "neighbors" | "proximity";
  nodes: { id: string; x: number; y: number; kind: NodeKind; label: string; landmark: boolean }[];
  edges: [string, string][];
  /** Floor plan placement in the graph's normalized frame (may extend past 0..1). Best effort: verify visually. */
  plan: { url: string; x: number; y: number; w: number; h: number } | null;
}

export interface RunView {
  property: { id: string; name: string; address: string; property_type: string | null; matterport_model_id: string | null } | null;
  graph: GraphView | null;
  candidates: { name: string; brand: string | null; confidence: string; image_url: string }[];
}

/**
 * Matterport plan images use a bottom-left origin in world meters (y up); sweeps are stored y-down (y = -worldY).
 * So the image spans x ∈ [ox, ox + W/res] and, y-down, y ∈ [-(oy + H/res), -oy]. Normalize like the graph.
 */
export function placePlan(plan: FloorPlanImage, g: { originX: number; originY: number; widthM: number; heightM: number }) {
  if (!plan.resolution || !plan.width || !plan.height || !g.widthM || !g.heightM) return null;
  const wM = plan.width / plan.resolution;
  const hM = plan.height / plan.resolution;
  const left = plan.originX;
  const top = -(plan.originY + hM);
  return { url: plan.url, x: (left - g.originX) / g.widthM, y: (top - g.originY) / g.heightM, w: wM / g.widthM, h: hM / g.heightM };
}

export function runView(run: OnboardingRun): RunView {
  const p = run.property;
  const g = run.graph;
  let graph: GraphView | null = null;
  if (g && g.nodes.length) {
    const floors = run.twin?.floors ?? [];
    const idx = run.graphFloorId ? floors.findIndex((f) => f.id === run.graphFloorId) : -1;
    // Plans come back in floor order; with one plan, it is the only floor's.
    const planImg = run.twin?.floorPlans?.[idx >= 0 ? idx : 0] ?? null;
    const landmarks = new Set(run.landmarkSweepIds);
    graph = {
      floor_id: run.graphFloorId ?? null,
      floor_label: idx >= 0 ? floors[idx].label : null,
      width_m: g.widthM,
      height_m: g.heightM,
      edge_source: g.edgeSource,
      nodes: g.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, kind: n.kind, label: n.label, landmark: !!n.sweepId && landmarks.has(n.sweepId) })),
      edges: g.edges.map((e) => [e.from, e.to] as [string, string]),
      plan: planImg ? placePlan(planImg, g) : null,
    };
  }
  return {
    property: p ? { id: p.id, name: p.name, address: p.address, property_type: p.propertyType, matterport_model_id: p.matterportModelId } : null,
    graph,
    candidates: run.candidates.slice(0, 50).map((c) => ({ name: c.name, brand: c.brand ?? null, confidence: c.confidence, image_url: c.image_url })),
  };
}

type AgentState = { messages?: unknown[]; todos?: unknown };

/**
 * Tool calls in order (including deepagents built-ins such as write_todos and task) and the agent's plan.
 * deepagents keeps the plan in state.todos; some models' runs leave it empty, so fall back to the last write_todos call.
 */
export function extractPlan(state: AgentState): { toolCalls: string[]; todos: unknown[] } {
  const calls = ((state.messages ?? []) as { tool_calls?: { name: string; args?: Record<string, unknown> }[] }[]).flatMap((m) => m?.tool_calls ?? []);
  const lastWrite = calls.filter((c) => c.name === "write_todos").at(-1)?.args?.todos;
  const todos = Array.isArray(state.todos) && state.todos.length ? state.todos : Array.isArray(lastWrite) ? lastWrite : [];
  return { toolCalls: calls.map((c) => c.name), todos };
}
