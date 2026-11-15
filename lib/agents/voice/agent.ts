import { createDeepAgent } from "deepagents";
import { tool } from "langchain";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { agentChatModel } from "../chatModel";
import { flushTraces } from "../tracing";
import { wayfindingTools, type WayfindingRun } from "../wayfinding/tools";
import type { WayfindingRequest } from "../wayfinding/agent";
import { planRouteToItem } from "@/lib/wayfinding/plan";
import type { WayfindingScene } from "@/lib/wayfinding/types";
import type { VoiceAction, VoiceMessage, VoiceResult } from "@/lib/voice/types";
import { guidanceFor } from "@/lib/voice/guidance";

const SYSTEM = `You control a 3D store simulation through voice, guiding a blind visitor.
Use find_item, locate_item and plan_route to ground destinations and directions. Never invent objects, coordinates, distances or turns.
For a new destination: find_item, optionally locate_item if missing, then plan_route. AMBIGUOUS means ask a short clarification and stop.
Use read_route for the existing destination. For 'take me there', 'walk', 'go' or 'resume', call start_guidance only after a valid route is available.
A request to find something only draws the route; it does not start walking without a request to move.
For 'turn left/right/around', call turn_view. For 'stop', call stop_guidance.
Moving and turning affect only the on-screen simulation. You cannot assess real-world safety or live obstacles from this stored scan.
Keep speech brief, at most three sentences. When giving route directions, repeat the planner's text exactly.
Do not call filesystem, planning or delegation tools. Only the scene tools are relevant.`;

export async function runVoiceAgent(scene: WayfindingScene, request: WayfindingRequest & {
  history?: VoiceMessage[]; currentItemId?: string; signal?: AbortSignal; headingDeg?: number;
}, deps: { model?: NonNullable<Parameters<typeof createDeepAgent>[0]>["model"] } = {}): Promise<VoiceResult> {
  request.signal?.throwIfAborted();
  const run: WayfindingRun = { scene: { ...scene, items: [...scene.items] }, start: request.start, detections: [], searchPhotos: request.searchPhotos, log: [] };
  const current = scene.items.find((item) => item.id === request.currentItemId);
  if (current) { run.item = current; run.plan = planRouteToItem(scene, request.start, current); }
  const actions: VoiceAction[] = [];
  let readRoute = false;
  const tools: StructuredToolInterface[] = wayfindingTools(run);
  const ready = () => run.plan?.status === "OK" || run.plan?.status === "ALREADY_THERE";
  tools.push(tool(async () => {
    readRoute = true;
    const plan = run.plan;
    return JSON.stringify(plan && "legs" in plan ? {
      status: plan.status, item: run.item?.name, directions: plan.legs.map((leg) => leg.text), distance_m: plan.totalDistanceM, warnings: plan.warnings,
    } : plan ?? { status: "NO_ROUTE" });
  }, {
    name: "read_route", description: "Read the current destination and deterministic route from the visitor's latest position.", schema: z.object({}),
  }));
  tools.push(tool(async () => {
    request.signal?.throwIfAborted();
    if (!ready()) return "NO_ROUTE: find an item and plan_route first.";
    if (!actions.some((a) => a.type === "move")) actions.push({ type: "move" });
    return "Guidance will start along the planned route in the simulation.";
  }, { name: "start_guidance", description: "Start or resume following the current route, only when the visitor asks to move.", schema: z.object({}) }));
  tools.push(tool(async () => {
    request.signal?.throwIfAborted();
    actions.splice(0, actions.length, { type: "stop" });
    return "Movement stopped.";
  }, { name: "stop_guidance", description: "Stop simulation movement and wait.", schema: z.object({}) }));
  tools.push(tool(async ({ direction }) => {
    request.signal?.throwIfAborted();
    actions.splice(0, actions.length, { type: "turn", degrees: direction === "left" ? 90 : direction === "right" ? -90 : 180 });
    return `Turn ${direction} in the simulation.`;
  }, { name: "turn_view", description: "Turn the simulated viewpoint left, right or around when requested.", schema: z.object({ direction: z.enum(["left", "right", "around"]) }) }));
  const agent = createDeepAgent({ model: deps.model ?? agentChatModel({ geminiMaxOutputTokens: 1000, anthropicMaxTokens: 1000 }), tools, systemPrompt: SYSTEM });
  try {
    const result = await agent.invoke({ messages: [...(request.history ?? []), { role: "user", content: request.query }] }, {
      signal: request.signal, recursionLimit: 18, runName: `voice ${scene.modelId}`, tags: ["storeguide", "voice"],
    });
    request.signal?.throwIfAborted();
    const changedRoute = run.log.some((entry) => entry.event === "plan_route");
    const last = result.messages.at(-1)?.content;
    const text = typeof last === "string" ? last : Array.isArray(last) ? last.map((part) => typeof part === "object" && part && "text" in part ? String(part.text) : "").join("") : "";
    // Navigation speech is always generated by the planner, not model-estimated turns or distances.
    const position = "position" in request.start ? request.start.position : scene.waypoints.find((w) => w.id === (request.start as { sweepId: string }).sweepId)?.position;
    const cue = run.plan && position && request.headingDeg !== undefined ? guidanceFor(run.plan, position, request.headingDeg) : null;
    const reply = (changedRoute || readRoute) && ready() && run.plan && "legs" in run.plan
      ? cue ? [cue.text, ...run.plan.warnings].join(" ") : [run.plan.status === "ALREADY_THERE" ? `You're at ${run.item?.name}.` : `${run.item?.name}.`, ...run.plan.legs.slice(0, 2).map((leg) => leg.text), ...run.plan.warnings].filter(Boolean).join(" ")
      : text.trim() || "Please tell me what you want to find.";
    return { reply: reply.slice(0, 2000), actions, item: run.item ?? null, plan: changedRoute || actions.some((a) => a.type === "move") ? run.plan ?? null : null };
  } finally { await flushTraces(); }
}
