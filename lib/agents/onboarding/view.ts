// Display model of an onboarding run for the staff screen: the draft graph in normalized coordinates, plus the
// floor plan image placed in the same frame when the twin has one. Pure, so it is unit tested.
import type { FloorPlanImage } from "../../costar";
import type { NodeKind } from "../../types";
import { sweepsToGraph, type DraftGraph } from "../../twin/sweepsToGraph";
import type { OnboardingRun } from "./run-context";

export interface GraphView {
  floor_id: string | null;
  floor_label: string | null;
  width_m: number;
  height_m: number;
  edge_source: "neighbors" | "proximity";
  /** Connected parts of the walkable graph (1 = fully connected). */
  components: number;
  /** True for the floor the agent built (entrance and landmarks chosen); false for floors drawn for the floor picker. */
  by_agent: boolean;
  nodes: { id: string; x: number; y: number; kind: NodeKind; label: string; landmark: boolean }[];
  edges: [string, string][];
  /** Floor plan placement in the graph's normalized frame (may extend past 0..1). Best effort: verify visually. */
  plan: { url: string; x: number; y: number; w: number; h: number } | null;
  /** Dev builds only: raw inputs behind `plan`, plus this floor's walls (normalized) to check alignment against. */
  debug?: PlanDebug;
}

export interface PlanDebug {
  graph: { originX: number; originY: number; widthM: number; heightM: number };
  plan: (FloorPlanImage & { widthM: number; heightM: number; planFloorId: string | null; matchedBy: PlanMatch }) | null;
  plansAvailable: { floorId: string | null; url: string }[];
  walls: { x1: number; y1: number; x2: number; y2: number }[];
}

export type PlanMatch = "floor-id" | "all-floors" | "single-floor";

export interface RunView {
  property: { id: string; name: string; address: string; property_type: string | null; matterport_model_id: string | null } | null;
  graph: GraphView | null;
  /**
   * The twin's other floors with scan points, drawn here with the same sweepsToGraph settings so staff can look at
   * every floor (floor picker). The agent didn't plan these: no entrance or landmarks are chosen on them.
   */
  other_floors: GraphView[];
  candidates: { name: string; brand: string | null; confidence: string; image_url: string }[];
  /** What inspect_aerial read from the overhead photo (entrance side, parking, approach). Advisory: staff confirm. */
  aerial: { notes: string } | null;
}

/**
 * The aerial image is a data URL that must stay server-side (AerialView in lib/costar/types.ts). The notes are built
 * from text only today; this guard keeps it that way if someone later folds the image or a URL into them.
 */
export function stripDataUrls(text: string): string {
  return text.replace(/data:[\w.+-]+\/[\w.+-]+(?:;[\w=.+-]+)*,[^\s"')\]]*/gi, "[image omitted]");
}

/**
 * Floor plan image → graph's normalized frame.
 *
 * Matterport (Floorplan schema): `origin` is the world position of the image's leftmost/bottommost pixel; image U
 * (left→right) runs along +x and image V (bottom→top) along +y; `resolution` is px per meter. So, in world meters
 * (y up), pixel column u and row r (row 0 = TOP of the image) sit at
 *     X = originX + u / res,      Y = originY + (height - r) / res.
 * The image covers X ∈ [originX, originX + W/res], Y ∈ [originY, originY + H/res]; row 0 is at Y = originY + H/res.
 *
 * mapTwin stores y-down: y = -Y. The image's top edge (row 0) is therefore at y = -(originY + H/res) and its bottom
 * edge at y = -originY. Rows increase downward in both the image and the y-down frame, so there is no mirroring:
 * the image is drawn upright, just translated and scaled.
 *
 * The graph normalizes nx = (x - g.originX) / g.widthM, ny = (y - g.originY) / g.heightM, giving the image box
 *     x = (originX - g.originX) / g.widthM            w = (W/res) / g.widthM
 *     y = (-(originY + H/res) - g.originY) / g.heightM   h = (H/res) / g.heightM
 * DraftGraphMap scales nx by its SVG width and ny by its SVG height, the same as nodes, with preserveAspectRatio="none",
 * so the image stretches exactly like the graph.
 *
 * Assumptions: plan origin and sweeps share Matterport's model frame (both documented as model coordinates); width/height
 * are the served image's pixel size; the half-pixel between the corner and the pixel center (0.5/res m) is ignored.
 */
export function placePlan(plan: FloorPlanImage, g: { originX: number; originY: number; widthM: number; heightM: number }) {
  if (!plan.resolution || !plan.width || !plan.height || !g.widthM || !g.heightM) return null;
  const wM = plan.width / plan.resolution;
  const hM = plan.height / plan.resolution;
  const left = plan.originX;
  const top = -(plan.originY + hM);
  return { url: plan.url, x: (left - g.originX) / g.widthM, y: (top - g.originY) / g.heightM, w: wM / g.widthM, h: hM / g.heightM };
}

/**
 * The plan for one floor. Matterport tags each plan with its floor (Floorplan.floor) and leaves it unset on a plan that
 * covers every floor; the list is not documented to follow floor order, so never pick by index. Exact floor match first,
 * then an all-floors plan (still aligned to the model frame, so placement is right; it may show other floors' rooms),
 * then, for a single-floor model, whatever plan there is. Otherwise no plan beats the wrong floor's plan.
 */
export function planForFloor(plans: FloorPlanImage[], floorCount: number, floorId: string | null | undefined): { plan: FloorPlanImage; matchedBy: PlanMatch } | null {
  const exact = floorId ? plans.find((p) => p.floorId === floorId) : undefined;
  if (exact) return { plan: exact, matchedBy: "floor-id" };
  const all = plans.find((p) => !p.floorId);
  if (all) return { plan: all, matchedBy: "all-floors" };
  if (floorCount <= 1 && plans[0]) return { plan: plans[0], matchedBy: "single-floor" };
  return null;
}

function floorView(run: OnboardingRun, g: DraftGraph, floorId: string | null, byAgent: boolean): GraphView {
  const floors = run.twin?.floors ?? [];
  const idx = floorId ? floors.findIndex((f) => f.id === floorId) : -1;
  const plans = run.twin?.floorPlans ?? [];
  const match = planForFloor(plans, floors.length, floorId);
  const planImg = match?.plan ?? null;
  const landmarks = new Set(byAgent ? run.landmarkSweepIds : []);
  const view: GraphView = {
    floor_id: floorId,
    floor_label: idx >= 0 ? floors[idx].label : null,
    width_m: g.widthM,
    height_m: g.heightM,
    edge_source: g.edgeSource,
    components: g.components.length,
    by_agent: byAgent,
    nodes: g.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, kind: n.kind, label: n.label, landmark: !!n.sweepId && landmarks.has(n.sweepId) })),
    edges: g.edges.map((e) => [e.from, e.to] as [string, string]),
    plan: planImg ? placePlan(planImg, g) : null,
  };
  if (process.env.NODE_ENV !== "production") {
    const nx = (x: number) => (x - g.originX) / g.widthM;
    const ny = (y: number) => (y - g.originY) / g.heightM;
    const walls = (floorId && run.twin?.walls?.[floorId]) || [];
    view.debug = {
      graph: { originX: g.originX, originY: g.originY, widthM: g.widthM, heightM: g.heightM },
      plan: match && planImg?.resolution
        ? { ...planImg, widthM: planImg.width / planImg.resolution, heightM: planImg.height / planImg.resolution, planFloorId: planImg.floorId ?? null, matchedBy: match.matchedBy }
        : null,
      plansAvailable: plans.map((p) => ({ floorId: p.floorId ?? null, url: p.url })),
      walls: walls.map((w) => ({ x1: nx(w.ax), y1: ny(w.ay), x2: nx(w.bx), y2: ny(w.by) })),
    };
  }
  return view;
}

/** Graphs for the twin's floors the agent didn't build, in the twin's floor order; floors without scan points are skipped. */
function otherFloors(run: OnboardingRun): GraphView[] {
  const twin = run.twin;
  if (!twin || !run.graph || twin.floors.length < 2) return [];
  return twin.floors
    .filter((f) => f.id !== run.graphFloorId && twin.sweeps.some((s) => s.floorId === f.id))
    .map((f) => floorView(run, sweepsToGraph(twin.sweeps, { floorId: f.id, walls: twin.walls?.[f.id] ?? [] }), f.id, false))
    .filter((v) => v.nodes.length > 0);
}

export function runView(run: OnboardingRun): RunView {
  const p = run.property;
  const g = run.graph;
  const graph = g && g.nodes.length ? floorView(run, g, run.graphFloorId ?? null, true) : null;
  return {
    property: p ? { id: p.id, name: p.name, address: p.address, property_type: p.propertyType, matterport_model_id: p.matterportModelId } : null,
    graph,
    other_floors: graph ? otherFloors(run) : [],
    candidates: run.candidates.slice(0, 50).map((c) => ({ name: c.name, brand: c.brand ?? null, confidence: c.confidence, image_url: c.image_url })),
    aerial: run.aerialNotes?.trim() ? { notes: stripDataUrls(run.aerialNotes.trim()) } : null,
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
