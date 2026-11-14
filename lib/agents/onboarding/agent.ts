// Store onboarding deep agent (LangChain deepagents track + CoStar track).
// Turns a CoStar property id into a DRAFT accessible-navigation map: property → Matterport twin → walkable graph
// → landmark references → shelf suggestions (subagent) → saved draft for staff review.
import { ChatAnthropic } from "@langchain/anthropic";
import { createDeepAgent } from "deepagents";
import { CLAUDE_MODEL } from "../../ai/claude";
import { getDataLayers } from "../../costar";
import { finishAgentRun, startAgentRun } from "../../db/writes";
import { newRun, type OnboardingRun } from "./run-context";
import { onboardingTools } from "./tools";

const SYSTEM = `You onboard a physical store into StoreGuide, an indoor navigation app for blind and low-vision shoppers.
Given a CoStar property id, produce a DRAFT navigation map that store staff will review. You never publish anything.

Plan with write_todos first, then:
1. lookup_property to identify the building and its Matterport model.
2. fetch_twin, then pick the floor with the public sales area (usually the ground floor).
3. inspect_aerial to find the public entrance. Choose the sweep nearest it as entrance_sweep_id when you can tell; otherwise pass null and say so.
4. build_draft_graph for that floor. Report warnings honestly: disconnected parts and proximity-inferred edges need staff attention.
5. propose_landmarks (about 6).
6. If panoramas exist for the landmarks, delegate shelf recognition for up to 3 of them to the shelf-recognizer subagent.
7. save_draft.

Finish with a short report for store staff: what was imported, the data source (state plainly if it is FIXTURE data, not real CoStar data),
and a checklist of what staff must verify before publishing. Never claim the map is verified or measured precisely.`;

export interface OnboardingResult {
  run_id: string;
  source: "costar" | "fixture";
  draft_id: string | null;
  report: string;
  todos: unknown;
  graph_summary: { nodes: number; edges: number; components: number; warnings: string[] } | null;
  candidates_queued: number;
  log: OnboardingRun["log"];
}

export async function runOnboarding(propertyId: string, startedBy: string | null): Promise<OnboardingResult> {
  const layers = getDataLayers();
  const runId = await startAgentRun({ costar_property_id: propertyId }, null, startedBy);
  const run = newRun(runId, layers);
  const tools = onboardingTools(run);
  const model = new ChatAnthropic({ model: CLAUDE_MODEL, maxTokens: 16000 });

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
    await finishAgentRun(runId, "SUCCEEDED", todos, run.log);
    return {
      run_id: runId,
      source: layers.source,
      draft_id: run.draftId ?? null,
      report,
      todos,
      graph_summary: run.graph ? { nodes: run.graph.nodes.length, edges: run.graph.edges.length, components: run.graph.components.length, warnings: run.graph.warnings } : null,
      candidates_queued: run.candidates.length,
      log: run.log,
    };
  } catch (err) {
    await finishAgentRun(runId, "FAILED", [], [...run.log, { at: new Date().toISOString(), event: "error", detail: String(err) }]);
    throw err;
  }
}
