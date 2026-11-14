// Store onboarding deep agent (LangChain deepagents track + CoStar track).
// Turns a CoStar property id into a DRAFT accessible-navigation map: property → Matterport twin → walkable graph
// → landmark references → shelf suggestions (subagent) → saved draft for staff review.
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { createDeepAgent } from "deepagents";
import { CLAUDE_MODEL } from "../../ai/claude";
import { GEMINI_AGENT_MODEL } from "../../ai/gemini";
import { toGeminiParameters } from "../../ai/geminiSchema";
import { aiProvider } from "../../ai/provider";
import { getDataLayers } from "../../costar";
import { finishAgentRun, startAgentRun } from "../../db/writes";
import { newRun, type OnboardingRun } from "./run-context";
import { onboardingTools } from "./tools";

const SYSTEM = `You onboard a physical store into StoreGuide, an indoor navigation app for blind and low-vision shoppers.
Given a CoStar property id, produce a DRAFT navigation map that store staff will review. You never publish anything.

Your FIRST action must be one write_todos call listing the steps below (staff watch this plan, so always write it, even though
the job looks short). Mark each todo completed as you finish it. Steps:
1. lookup_property to identify the building and its Matterport model.
2. fetch_twin, then pick the floor with the public sales area (usually the ground floor).
3. inspect_aerial to find the public entrance. Choose the sweep nearest it as entrance_sweep_id when you can tell; otherwise pass null and say so.
4. build_draft_graph for that floor.
5. propose_landmarks (about 6).
6. If panoramas exist for the landmarks, delegate shelf recognition for up to 3 of them to the shelf-recognizer subagent.
7. save_draft.

Finish with a short report for store staff: what was imported, the data source (state plainly if it is FIXTURE data, not real CoStar data),
and a checklist of what staff must verify before publishing. Never claim the map is verified or measured precisely.
State only facts that tool outputs returned. List exactly the warnings build_draft_graph returned; if fully_connected is false or
edge_source is "proximity", say staff must fix that. Always include: walk the routes, confirm the entrance, photograph landmarks.`;

/** Gemini rejects parts of JSON Schema that deepagents' built-in tools use; rewrite every tool schema on bind. */
class GeminiChat extends ChatGoogleGenerativeAI {
  override bindTools(...[tools, kwargs]: Parameters<ChatGoogleGenerativeAI["bindTools"]>) {
    const cleaned = tools.map((t) => {
      const oa = convertToOpenAITool(t);
      return { ...oa, function: { ...oa.function, parameters: toGeminiParameters(oa.function.parameters) } };
    });
    return super.bindTools(cleaned, kwargs);
  }
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
  log: OnboardingRun["log"];
}

export async function runOnboarding(propertyId: string, startedBy: string | null): Promise<OnboardingResult> {
  const layers = getDataLayers();
  const runId = await startAgentRun({ costar_property_id: propertyId }, null, startedBy);
  const run = newRun(runId, layers);
  const tools = onboardingTools(run);
  // Same deep agent either way; only the chat model changes.
  const model =
    aiProvider() === "gemini"
      ? new GeminiChat({ model: GEMINI_AGENT_MODEL, apiKey: process.env.GEMINI_API_KEY, maxOutputTokens: 8000 })
      : new ChatAnthropic({ model: CLAUDE_MODEL, maxTokens: 16000 });

  const agent = createDeepAgent({
    model,
    tools: tools.main,
    systemPrompt: SYSTEM,
    subagents: [
      {
        name: "shelf-recognizer",
        description: "Identifies products in shelf images or panorama crops and queues them as NEEDS_REVIEW suggestions. Give it image URLs and the aisle if known.",
        systemPrompt: "Call recognize_shelf_image once per image you are given, then reply with how many suggestions were queued per image. Do not invent products.",
        tools: tools.shelf,
      },
    ],
  });

  try {
    const result = await agent.invoke(
      { messages: [{ role: "user", content: `Onboard CoStar property ${propertyId}.` }] },
      { recursionLimit: 60 },
    );
    const last = result.messages.at(-1);
    const report = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
    const todos = (result as { todos?: unknown }).todos ?? [];
    // Every tool the agent called, in order (includes deepagents built-ins such as write_todos and task).
    const toolCalls = (result.messages as { tool_calls?: { name: string }[] }[]).flatMap((m) => m.tool_calls?.map((c) => c.name) ?? []);
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
      log: run.log,
    };
  } catch (err) {
    await finishAgentRun(runId, "FAILED", [], [...run.log, { at: new Date().toISOString(), event: "error", detail: String(err) }]);
    throw err;
  }
}
