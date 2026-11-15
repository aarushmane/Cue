// Wayfinding deep agent (LangChain deepagents): "where are the chips?" → find the item → plan an obstacle-free route
// → short spoken answer. The structured route (polyline, arrows, scan points) comes from the planner run state, not
// from the model's text, so what is drawn on screen is always the deterministic plan.
import { createDeepAgent } from "deepagents";
import { agentChatModel } from "../chatModel";
import { flushTraces } from "../tracing";
import type { Detection } from "../../wayfinding/locate";
import type { RoutePlan, SceneItem, StartPoint, WayfindingScene } from "../../wayfinding/types";
import { wayfindingTools, type WayfindingRun } from "./tools";

const SYSTEM = `You guide a visitor to an item inside a 3D-scanned store. Use the tools; never estimate positions, distances or directions yourself.

1. Call find_item with the visitor's words.
   - AMBIGUOUS: ask which one they mean, naming the options, and stop.
   - NO_MATCH: say the item is not listed in the catalogue. Only call locate_item if the visitor explicitly requested a photo search or supplied detections. If that does not return OK, say the item could not be verified and stop.
2. Call plan_route with the item id.
3. Answer in at most three short sentences. Repeat the planner's directions word for word; do not add turns or distances.
   If plan_route did not return OK or ALREADY_THERE, explain its reason plainly. Mention any warnings briefly.`;

export interface WayfindingRequest {
  query: string;
  start: StartPoint;
  detections?: { label: string; detections: Detection[] }[];
  /** Photo search (lib/wayfinding/vision findInPhotos), injected by the API route. */
  searchPhotos?: WayfindingRun["searchPhotos"];
  signal?: AbortSignal;
}

export interface WayfindingResult {
  reply: string;
  item: SceneItem | null;
  plan: RoutePlan | null;
  tool_calls: string[];
  log: WayfindingRun["log"];
}

/** `model` is injectable for tests; production uses the shared provider-selected chat model. */
export async function runWayfinding(
  scene: WayfindingScene, request: WayfindingRequest, deps: { model?: NonNullable<Parameters<typeof createDeepAgent>[0]>["model"] } = {},
): Promise<WayfindingResult> {
  const run: WayfindingRun = {
    scene: { ...scene, items: [...scene.items] }, start: request.start, detections: request.detections ?? [], searchPhotos: request.searchPhotos, log: [],
  };
  const agent = createDeepAgent({
    model: deps.model ?? agentChatModel({ geminiMaxOutputTokens: 2000, anthropicMaxTokens: 2000 }),
    tools: wayfindingTools(run),
    systemPrompt: SYSTEM,
  });
  try {
    const state = await agent.invoke(
      { messages: [{ role: "user", content: request.query }] },
      { signal: request.signal, recursionLimit: 10, runName: `wayfind ${scene.modelId}`, tags: ["storeguide", "wayfinding"], metadata: { model_id: scene.modelId } },
    );
    const messages = (state.messages ?? []) as { content?: unknown; tool_calls?: { name: string }[] }[];
    const last = messages.at(-1);
    const reply = typeof last?.content === "string"
      ? last.content
      : Array.isArray(last?.content) ? last.content.map((p) => (typeof p === "object" && p && "text" in p ? String(p.text) : "")).join("") : "";
    return {
      reply: reply.trim(),
      item: run.item ?? null,
      plan: run.plan ?? null,
      tool_calls: messages.flatMap((m) => m.tool_calls?.map((c) => c.name) ?? []),
      log: run.log,
    };
  } finally {
    await flushTraces();
  }
}
