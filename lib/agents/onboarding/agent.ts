// Store onboarding deep agent (LangChain deepagents track + CoStar track).
// Turns a CoStar property id into a DRAFT accessible-navigation map: property → Matterport twin → walkable graph
// → landmark references → shelf suggestions (subagent) → saved draft for staff review.
import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import { createDeepAgent } from "deepagents";
import { todoListMiddleware } from "langchain";
import { agentChatModel } from "../chatModel";
import { getDataLayers } from "../../costar";
import { finishAgentRun, startAgentRun } from "../../db/writes";
import { extractPlan, runView, type RunView } from "./view";
import { DEFAULT_STORE_ID, newRun, type OnboardingRun } from "./run-context";
import { onboardingTools } from "./tools";
import { createUpdatesAccumulator, type OnboardEvent } from "./progress";

const SYSTEM = `You onboard a physical store into StoreGuide, an indoor navigation app for blind and low-vision shoppers.
Given a CoStar property id (or a Matterport model id), produce a DRAFT navigation map that store staff will review. You never publish anything.

Your FIRST action must be one write_todos call listing the steps below (staff watch this plan, so always write it, even though
the job looks short). Mark each todo completed as you finish it. Steps:
1. lookup_property to identify the building and its Matterport model.
2. fetch_twin, then pick the floor with the public sales area (usually the ground floor).
3. inspect_aerial to describe the outdoor approach (entrance side, parking). For entrance_sweep_id use a scan point from
   fetch_twin's entrance_candidates on that floor when there is one; otherwise pass null and say staff must mark it.
4. build_draft_graph for that floor.
5. propose_landmarks (about 6).
6. If panoramas exist for the landmarks, delegate shelf recognition for up to 3 of them to the shelf-recognizer subagent.
7. save_draft.

Finish with a short report for store staff: what was imported, the data source (state plainly if it is FIXTURE data, not real CoStar data),
and a checklist of what staff must verify before publishing. Never claim the map is verified or measured precisely.
State only facts that tool outputs returned. List exactly the warnings build_draft_graph returned; if fully_connected is false or
edge_source is "proximity", say staff must fix that. Always include: walk the routes, confirm the entrance, photograph landmarks.`;

// Same env vars @langchain/core checks before attaching the LangSmith tracer.
const tracingOn = () =>
  ["LANGSMITH_TRACING_V2", "LANGCHAIN_TRACING_V2", "LANGSMITH_TRACING", "LANGCHAIN_TRACING"].some((k) => process.env[k] === "true");

/**
 * Serverless functions can freeze as soon as the response is sent, losing trace batches still in flight. Drain
 * LangChain's callback queue and the LangSmith client's pending batches before returning, capped so a slow
 * LangSmith never holds up the staff response for long. No-op (and no LangSmith client created) when tracing is off.
 */
export async function flushTraces(timeoutMs = 10_000) {
  if (!tracingOn()) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    awaitAllCallbacks().catch(() => undefined),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  clearTimeout(timer);
}

export interface OnboardingResult {
  run_id: string;
  source: "costar" | "fixture";
  draft_id: string | null;
  report: string;
  todos: unknown;
  tool_calls: string[];
  graph_summary: { nodes: number; edges: number; components: number; warnings: string[] } | null;
  candidates_queued: number;
  /** Observation ids added to the staff Review queue (empty if save_draft didn't run or queueing failed). */
  review_observation_ids: string[];
  store_id: string;
  log: OnboardingRun["log"];
  /** Display model for the staff onboarding screen (property, draft graph geometry, candidates). */
  view: RunView;
}

export interface OnboardingOptions {
  store_id?: string;
}

function buildAgent(run: OnboardingRun) {
  const tools = onboardingTools(run);
  // Same deep agent either way; only the chat model changes.
  const model = agentChatModel({ geminiMaxOutputTokens: 8000, anthropicMaxTokens: 16000 });

  return createDeepAgent({
    model,
    tools: tools.main,
    systemPrompt: SYSTEM,
    // deepagents 1.16 no longer bundles write_todos (calls to it failed as "not a valid tool", so state.todos stayed
    // empty and the plan only survived via extractPlan's fallback). The middleware restores the tool and state.todos,
    // which is what the live plan streams from.
    middleware: [todoListMiddleware()],
    subagents: [
      {
        name: "shelf-recognizer",
        description: "Identifies products in shelf images or panorama crops and queues them as NEEDS_REVIEW suggestions. Give it image URLs and the aisle if known.",
        systemPrompt: "Call recognize_shelf_image once per image you are given, then reply with how many suggestions were queued per image. Do not invent products.",
        tools: tools.shelf,
      },
    ],
  });
}

type Agent = ReturnType<typeof buildAgent>;
type AgentInput = Parameters<Agent["invoke"]>[0];
/** Runs the agent to completion and returns its final state (messages + todos). The only part invoke and stream differ in. */
type Execute = (agent: Agent, input: AgentInput, config: RunConfig) => Promise<{ messages?: unknown[]; todos?: unknown }>;
/** Options both paths pass to the agent: recursion limit plus LangSmith trace labels. */
type RunConfig = { recursionLimit: number; runName: string; tags: string[]; metadata: Record<string, string> };

const RECURSION_LIMIT = 60;

/** Shared by the invoke and stream paths: start the run record, run the agent, build the same OnboardingResult. */
async function executeOnboarding(propertyId: string, startedBy: string | null, opts: OnboardingOptions, execute: Execute): Promise<OnboardingResult> {
  const storeId = opts.store_id || DEFAULT_STORE_ID;
  const layers = getDataLayers();
  const runId = await startAgentRun({ costar_property_id: propertyId, store_id: storeId }, storeId, startedBy);
  const run = newRun(runId, layers, storeId);
  const agent = buildAgent(run);

  try {
    const config: RunConfig = {
      recursionLimit: RECURSION_LIMIT,
      // LangSmith trace labels only (no effect on the agent). Never put secrets here: metadata is sent to LangSmith.
      runName: `onboard ${propertyId}`,
      tags: ["storeguide", "onboarding", layers.source],
      metadata: { run_id: runId, property_id: propertyId },
    };
    const state = await execute(agent, { messages: [{ role: "user", content: `Onboard CoStar property ${propertyId}.` }] }, config);
    const last = state.messages?.at(-1) as { content?: unknown } | undefined;
    const report = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
    const { toolCalls, todos } = extractPlan(state);
    await finishAgentRun(runId, "SUCCEEDED", todos, run.log);
    return {
      run_id: runId,
      source: layers.source,
      draft_id: run.draftId ?? null,
      report,
      todos,
      tool_calls: toolCalls,
      graph_summary: run.graph ? { nodes: run.graph.nodes.length, edges: run.graph.edges.length, components: run.graph.components.length, warnings: run.graph.warnings } : null,
      candidates_queued: run.candidates.length,
      review_observation_ids: run.observationIds,
      store_id: run.storeId,
      log: run.log,
      view: runView(run),
    };
  } catch (err) {
    await finishAgentRun(runId, "FAILED", [], [...run.log, { at: new Date().toISOString(), event: "error", detail: String(err) }]);
    throw err;
  } finally {
    await flushTraces(); // failed runs are the ones judges most need to see, so flush on both paths
  }
}

/** Run to completion and return the result (the Server Function fallback and POST /api/agent/onboard). */
export function runOnboarding(propertyId: string, startedBy: string | null, opts: OnboardingOptions = {}): Promise<OnboardingResult> {
  return executeOnboarding(propertyId, startedBy, opts, (agent, input, config) => agent.invoke(input, config));
}

/**
 * Same run, streamed: calls `onEvent` with plan (todos) and tool-call progress as the graph's nodes finish, then
 * resolves with the same OnboardingResult as runOnboarding. Aborting `signal` stops the agent (the run is recorded FAILED).
 */
export function runOnboardingStream(
  propertyId: string, startedBy: string | null, opts: OnboardingOptions, io: { onEvent: (e: OnboardEvent) => void; signal?: AbortSignal },
): Promise<OnboardingResult> {
  return executeOnboarding(propertyId, startedBy, opts, async (agent, input, config) => {
    const acc = createUpdatesAccumulator();
    const stream = await agent.stream(input, { ...config, streamMode: "updates", signal: io.signal });
    for await (const chunk of stream) for (const e of acc.push(chunk)) io.onEvent(e);
    return acc.state();
  });
}
