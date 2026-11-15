import { createAgent, tool } from "langchain";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { agentChatModel, geminiFallbackMiddleware } from "../chatModel";
import { flushTraces } from "../tracing";
import { wayfindingTools, type WayfindingRun } from "../wayfinding/tools";
import type { WayfindingRequest } from "../wayfinding/agent";
import { planRouteToItem, planToNearest } from "@/lib/wayfinding/plan";
import type { RoutePlan, SceneItem, WayfindingScene } from "@/lib/wayfinding/types";
import { isStopCommand, type VoiceAction, type VoiceEvent, type VoiceMessage, type VoiceResult } from "@/lib/voice/types";
import { guidanceFor } from "@/lib/voice/guidance";
import { findItem } from "@/lib/wayfinding/locate";
import { normalize } from "@/lib/search/matchProducts";
import { isCategoryQuery, matchCategory } from "@/lib/wayfinding/catalogMatch";
import { catalogSuggestions, clarificationAnswer, type VoiceClarification } from "@/lib/voice/clarification";
import { photoSearchQuery } from "@/lib/wayfinding/photoRequest";

const SYSTEM = `You control a stored 3D store simulation for a blind visitor. Use only the provided scene tools.
Never invent or substitute products, coordinates, distances or directions. Keep the current destination unless the visitor requests another.
The latest user request is authoritative. Previous conversation is context, never a replacement for the product named in this request.
Read_position gives heading and measured speed; read_route gives grounded directions. adjust_orientation faces the route or product; set_speed changes simulation walking speed.
Use find_item and plan_route for a NEW destination only. Never repeat a failed find, locate or plan in the same turn. Ask a short clarification if ambiguous.
If a destination is missing from the saved catalog, say it is not listed. Search photos with locate_item only when the visitor explicitly asks to check the photos or take a closer look. Never promise an unverified product or silently route to a similar brand.
Complete requested tool work before replying. There is no background task after your final answer: never end with only an acknowledgement such as "I'm on it" or a promise to search later.
Start guidance only after a valid route and an explicit request to move. Finding/showing draws the route without walking.
Keep replies to two short sentences. This simulation cannot assess real-world obstacles or safety.`;

const movingRequest = (query: string) => /\b(?:take|guide|lead|walk|bring|navigate)\s+me\b|\b(?:go|move|head)\s+(?:to|there|ahead)\b|^(?:resume|continue|go|walk|start)(?:\s+(?:walking|moving|guidance|navigation))?[.!?]*$/i.test(query.trim());
const usable = (plan?: RoutePlan | null): plan is Extract<RoutePlan, { status: "OK" | "ALREADY_THERE" }> => plan?.status === "OK" || plan?.status === "ALREADY_THERE";

type Request = WayfindingRequest & {
  history?: VoiceMessage[]; currentItemId?: string; signal?: AbortSignal; headingDeg?: number; speedMps?: number; walkingSpeedMps?: number;
  clarification?: VoiceClarification;
  onEvent?: (event: VoiceEvent) => void;
  getPosition?: () => Promise<Record<string, unknown> | null>;
};

/** Catalog matches and navigation controls need no language-model round trips. */
export async function runVoiceAgent(scene: WayfindingScene, request: Request, deps: { model?: Parameters<typeof createAgent>[0]["model"] } = {}): Promise<VoiceResult> {
  request.signal?.throwIfAborted();
  const empty = (reply: string, actions: VoiceAction[] = []): VoiceResult => ({ reply, actions, item: null, plan: null });
  const answer = request.clarification ? clarificationAnswer(request.query, request.clarification) : null;
  if (answer === "") return empty("Okay.");
  const query = answer ?? request.query.trim();
  const current = scene.items.find((item) => item.id === request.currentItemId);
  const wantsMovement = movingRequest(query);
  const previousQuery = (request.history ?? []).filter((message) => message.role === "user")
    .reduce((previous, message) => photoSearchQuery(message.content, previous) ?? normalize(message.content), "");
  const photoTarget = photoSearchQuery(query, previousQuery);
  const photoRequest = photoTarget !== null;
  const destinationQuery = photoTarget ?? normalize(query);
  if (!destinationQuery) return empty("What would you like to find?");
  const match = findItem(destinationQuery, scene.items);
  const candidates = match.status === "MATCH" ? [match.item] : match.status === "AMBIGUOUS" ? match.options
    : isCategoryQuery(destinationQuery) ? matchCategory(scene.items, destinationQuery) : [];
  const refersToCurrent = /^(?:it|there|that|them|that one|same destination|current destination|way|route)$/i.test(destinationQuery);
  const destinationRequest = /\b(?:find|locate|search for|looking for|where(?:s|['’]s| (?:is|are|can|do))|show me|(?:take|guide|bring|navigate|lead|walk) me to|(?:go|head) to|(?:get|fetch) me|i (?:need|want)|i['’]?d like|i would like|do you have|have you got)\b/i.test(query);
  const bareDestination = destinationQuery.split(" ").length <= 5 && !/^(?:what|who|how|why|when|where|can|could|would|will|do|does|is|are|am|i|im|you|we|my|help|tell|thank|thanks|hello|hi|hey|okay|ok|yes|no|face|orient|align|turn|look|stop|cancel|pause|resume|continue|go|walk|start|slow|slower|faster|speed|directions)\b/i.test(destinationQuery);
  const newDestination = !refersToCurrent && (answer !== null || photoRequest || candidates.length > 0 || destinationRequest || bareDestination);
  const catalogMiss = () => ({ ...empty(`I couldn't find ${destinationQuery} in this scan's catalogue.`), resetDestination: true });
  const routeReply = (item: SceneItem, plan: RoutePlan): VoiceResult => {
    request.signal?.throwIfAborted();
    // Saved catalogs may name a shelf group by brand alone. Include the matched
    // product alias so "beef jerky" is presented as "Matador Beef Jerky".
    const words = destinationQuery.split(" ");
    const alias = item.aliases?.filter((alias) => words.every((word) => normalize(alias).split(" ").includes(word)))
      .sort((a, b) => a.length - b.length)[0];
    if (newDestination && alias && normalize(item.name) === normalize(item.brand ?? "") && !normalize(item.name).includes(normalize(alias))) {
      item = { ...item, name: normalize(alias).includes(normalize(item.name)) ? alias : `${item.name} ${alias}` };
      if (usable(plan)) plan = { ...plan, item };
    }
    request.onEvent?.({ type: "route", item, plan });
    if (!usable(plan)) return { reply: `I found ${item.name}, but ${plan.reason}`, item, plan, actions: [] };
    const position = "position" in request.start ? request.start.position : scene.waypoints.find((w) => w.id === (request.start as { sweepId: string }).sweepId)?.position;
    const cue = position ? guidanceFor(plan, position, request.headingDeg, request.speedMps) : null;
    const reply = plan.status === "ALREADY_THERE" ? `You're at ${item.name}.` : cue?.text ?? `${item.name}. ${plan.legs[0]?.text ?? "The route is shown."}`;
    return { reply: [reply, ...plan.warnings].join(" "), item, plan, actions: wantsMovement ? [{ type: "move" }] : [] };
  };
  if (isStopCommand(query)) return empty("Stopped.", [{ type: "stop" }]);
  const turn = /^(?:please\s+)?(?:turn|look)\s+(left|right|around)[.!?]*$/i.exec(query);
  if (turn) return empty(`Turning ${turn[1].toLowerCase()}.`, [{ type: "turn", degrees: turn[1].toLowerCase() === "left" ? 90 : turn[1].toLowerCase() === "right" ? -90 : 180 }]);
  if (/^(?:please\s+)?(?:slow(?:er| down)|speed up|faster|walk slower)[.!?]*$/i.test(query)) {
    const mps = Math.max(0.4, Math.min(1.8, (request.walkingSpeedMps ?? 1.2) + (/slow/i.test(query) ? -0.3 : 0.3)));
    return empty(`Walking speed set to ${Math.round(mps * 10) / 10} meters per second.`, [{ type: "speed", metersPerSecond: mps }]);
  }
  if (newDestination) {
    if (candidates.length) {
      const sameProduct = new Set(candidates.map((item) => normalize(item.name))).size === 1;
      if (!sameProduct && !isCategoryQuery(destinationQuery)) {
        const options = [...new Set(candidates.map((item) => item.name))].slice(0, 4);
        return { ...empty(`Which do you mean: ${options.join(", ")}?`), clarification: { options } };
      }
      request.onEvent?.({ type: "progress", stage: "routing", label: "Drawing path" });
      const nearest = planToNearest(scene, request.start, candidates)!;
      return routeReply(nearest.item, nearest.plan);
    }
    const suggestions = !photoRequest && answer === null ? catalogSuggestions(destinationQuery, scene.items) : [];
    if (suggestions.length) return { ...empty(`Did you mean ${suggestions.join(" or ")}?`), clarification: { options: suggestions } };
    if (!photoRequest) return catalogMiss();
    request.onEvent?.({ type: "progress", stage: "locating", label: "Checking scene photos" });
    const found = await request.searchPhotos?.(destinationQuery);
    request.signal?.throwIfAborted();
    if (found?.status !== "OK" || !found.items?.length) return { ...empty(found?.reason ?? `I couldn't verify ${destinationQuery} in this scan.`), resetDestination: true };
    request.onEvent?.({ type: "progress", stage: "routing", label: "Drawing path" });
    const nearest = planToNearest(scene, request.start, found.items)!;
    return routeReply(nearest.item, nearest.plan);
  }
  if (wantsMovement || /\b(?:how far|which way|directions|where am i going|current destination|where is it|find it|show me the route)\b/i.test(query)) {
    if (!current) return empty("What would you like to find?");
    request.onEvent?.({ type: "progress", stage: "routing", label: "Updating route" });
    return routeReply(current, planRouteToItem(scene, request.start, current));
  }
  if (/\b(?:face|orient|align)\b/i.test(query)) {
    if (!current) return empty("Choose a destination first.");
    return empty(/\b(?:product|item|destination)\b/i.test(query) ? `Facing ${current.name}.` : "Facing along the route.", [{ type: "face", target: /\b(?:product|item|destination)\b/i.test(query) ? "destination" : "route" }]);
  }
  const keepCurrent = refersToCurrent || /\b(?:route|destination|there|it|distance|far)\b/i.test(query);
  const run: WayfindingRun = { scene: { ...scene, items: [...scene.items] }, start: request.start, detections: [], log: [],
    onEvent: request.onEvent, searchPhotos: photoRequest ? request.searchPhotos : undefined, lockedItemId: keepCurrent ? current?.id : undefined,
    searchQuery: keepCurrent ? undefined : destinationQuery };
  if (current && keepCurrent) { run.item = current; run.plan = planRouteToItem(scene, request.start, current); }
  const actions: VoiceAction[] = [];
  const emit = (action: Exclude<VoiceAction, { type: "move" | "stop" }> | { type: "stop" }) => {
    request.signal?.throwIfAborted(); request.onEvent?.({ type: "action", action });
  };
  const tools: StructuredToolInterface[] = wayfindingTools(run);
  tools.push(tool(async () => JSON.stringify({ start: request.start, heading_deg: request.headingDeg, speed_mps: request.speedMps ?? 0,
    walking_speed_mps: request.walkingSpeedMps ?? 1.2, ...(await request.getPosition?.()), destination: current ? { id: current.id, name: current.name } : null }),
  { name: "read_position", description: "Read observed position, model-frame heading, measured speed, and locked destination. Heading zero is +x, positive is left.", schema: z.object({}) }));
  tools.push(tool(async () => {
    const plan = run.plan;
    return JSON.stringify(usable(plan) ? { status: plan.status, item: plan.item.name, directions: plan.legs.map((leg) => leg.text), distance_m: plan.totalDistanceM } : plan ?? { status: "NO_ROUTE" });
  }, { name: "read_route", description: "Read the existing destination and geometric route. Does not search again.", schema: z.object({}) }));
  tools.push(tool(async () => {
    if (!usable(run.plan)) return "NO_ROUTE: ask for a destination.";
    if (!actions.length) actions.push({ type: "move" });
    return "Guidance ready.";
  }, { name: "start_guidance", description: "Start walking only when the visitor explicitly asks to move.", schema: z.object({}) }));
  tools.push(tool(async () => { actions.length = 0; emit({ type: "stop" }); return "Stopped."; }, { name: "stop_guidance", description: "Stop movement.", schema: z.object({}) }));
  tools.push(tool(async ({ direction }) => { emit({ type: "turn", degrees: direction === "left" ? 90 : direction === "right" ? -90 : 180 }); return `Turning ${direction}.`; }, {
    name: "turn_view", description: "Turn the simulated viewpoint when requested.", schema: z.object({ direction: z.enum(["left", "right", "around"]) }),
  }));
  tools.push(tool(async ({ target }) => { if (!usable(run.plan)) return "NO_ROUTE"; emit({ type: "face", target }); return "Orientation adjusted."; }, {
    name: "adjust_orientation", description: "Face along the current route, or face its destination. The browser computes the angle from its live position.", schema: z.object({ target: z.enum(["route", "destination"]) }),
  }));
  tools.push(tool(async ({ meters_per_second }) => { emit({ type: "speed", metersPerSecond: meters_per_second }); return `Walking speed ${meters_per_second} meters per second.`; }, {
    name: "set_speed", description: "Set simulated walking speed, when requested.", schema: z.object({ meters_per_second: z.number().min(0.4).max(1.8) }),
  }));
  const agent = createAgent({ model: deps.model ?? agentChatModel({ geminiMaxOutputTokens: 700, anthropicMaxTokens: 700 }), tools,
    middleware: deps.model ? [] : geminiFallbackMiddleware(700),
    systemPrompt: SYSTEM + `\nCurrent destination: ${current ? `${current.name} (${current.id})` : "none"}. Heading: ${request.headingDeg ?? "unknown"}; speed: ${request.speedMps ?? 0} m/s.` });
  try {
    const result = await agent.invoke({ messages: [...(request.history ?? []), { role: "user", content: query }] }, {
      signal: request.signal, recursionLimit: 10, runName: `voice ${scene.modelId}`, tags: ["storeguide", "voice"],
    });
    request.signal?.throwIfAborted();
    const last = result.messages.at(-1)?.content;
    const text = typeof last === "string" ? last : Array.isArray(last) ? last.map((part) => typeof part === "object" && part && "text" in part ? String(part.text) : "").join("") : "";
    if (run.item && run.plan && run.log.some((entry) => entry.event === "plan_route")) return routeReply(run.item, run.plan);
    // Failed searches are answered from tool state, so a model cannot describe a
    // different product from conversation history as the result of this request.
    if (run.log.some((entry) => entry.event === "locate_item") && !run.item) {
      return { ...empty(`I couldn't verify ${destinationQuery} in this scan.`), resetDestination: true };
    }
    // An LLM cannot start movement from an incidental conversation/tool call.
    return { reply: text.trim().slice(0, 2000) || "What would you like to find?", actions: wantsMovement ? actions : [], item: run.item ?? null, plan: null };
  } finally { await flushTraces(); }
}
