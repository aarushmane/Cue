// Visual localization (manual §08): match shopper camera frames against the store's known landmarks.
// The model only *classifies* which landmark is visible; confidence → CONFIRMED / LIKELY / UNKNOWN is decided
// here in code, together with map adjacency to the previous position. Frames are never stored or logged.
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CLAUDE_MODEL, FALLBACK_PARAMS, getClaude, imageSource } from "../ai/claude";
import type { Landmark, LocalizeResult, StoreGraph } from "../types";

const LandmarkMatch = z.object({
  landmark_id: z.string().nullable(), // one of the provided ids, or null when none is clearly visible
  confidence: z.enum(["high", "medium", "low"]),
  evidence: z.string(), // what in the frame supports the match, e.g. "blue sign reading AISLE 2 – DAIRY"
});
export type LandmarkMatch = z.infer<typeof LandmarkMatch>;

/** Neighbors-of-previous-node ordering, so likely landmarks are listed first and adjacency can upgrade confidence. */
function adjacentNodeIds(graph: StoreGraph, nodeId: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!nodeId) return out;
  out.add(nodeId);
  for (const e of graph.edges) {
    if (e.from === nodeId) out.add(e.to);
    if (e.to === nodeId) out.add(e.from);
  }
  return out;
}

/** Pure: turn a model classification into a positioning decision. Exported for tests. */
export function decidePosition(match: LandmarkMatch, landmarks: Landmark[], graph: StoreGraph, previousNodeId?: string | null): LocalizeResult {
  const lm = match.landmark_id ? landmarks.find((l) => l.id === match.landmark_id) : undefined;
  if (!lm || !graph.nodes.some((n) => n.id === lm.nodeId)) {
    return { confidence_state: "UNKNOWN", selected_node_id: null, candidate_node_ids: [], landmark_id: null, evidence: match.evidence };
  }
  const near = adjacentNodeIds(graph, previousNodeId);
  const plausible = !previousNodeId || near.has(lm.nodeId);
  let state: LocalizeResult["confidence_state"] = "UNKNOWN";
  if (match.confidence === "high" && plausible) state = "CONFIRMED";
  else if (match.confidence === "high" || (match.confidence === "medium" && plausible)) state = "LIKELY";
  return {
    confidence_state: state,
    selected_node_id: state === "UNKNOWN" ? null : lm.nodeId,
    candidate_node_ids: [lm.nodeId],
    landmark_id: lm.id,
    evidence: match.evidence,
  };
}

async function referenceImage(url: string | null): Promise<string | null> {
  if (!url || !url.startsWith("/")) return null; // only local demo references for now
  try {
    const buf = await readFile(path.join(process.cwd(), "public", url));
    return buf.toString("base64");
  } catch {
    return null; // reference photo not taken yet; the text description is still used
  }
}

export async function matchLandmark(args: {
  frames: string[]; // data URLs or base64 JPEG
  landmarks: Landmark[];
  graph: StoreGraph;
  previousNodeId?: string | null;
}): Promise<LocalizeResult> {
  const { frames, landmarks, graph, previousNodeId } = args;
  if (landmarks.length === 0) {
    return { confidence_state: "UNKNOWN", selected_node_id: null, candidate_node_ids: [], landmark_id: null, evidence: "This store has no reference landmarks yet." };
  }
  const near = adjacentNodeIds(graph, previousNodeId);
  const ordered = [...landmarks].sort((a, b) => Number(near.has(b.nodeId)) - Number(near.has(a.nodeId)));

  type Block = { type: "text"; text: string } | { type: "image"; source: ReturnType<typeof imageSource> };
  const content: Block[] = [{ type: "text", text: "Reference landmarks for this store:" }];
  for (const l of ordered) {
    content.push({ type: "text", text: `Landmark ${l.id}: ${l.description}` });
    const ref = await referenceImage(l.imageUrl);
    if (ref) content.push({ type: "image", source: imageSource(ref) });
  }
  content.push({ type: "text", text: `Shopper camera frames (${frames.length}):` });
  for (const f of frames) content.push({ type: "image", source: imageSource(f) });
  content.push({
    type: "text",
    text:
      "Which single reference landmark is clearly visible in the shopper frames? Answer with its id, or null if none is clearly visible. " +
      "Use high confidence only when distinctive text or a unique feature matches. Never guess between two similar landmarks — answer null instead.",
  });

  const res = await getClaude().beta.messages.parse({
    model: CLAUDE_MODEL,
    max_tokens: 2000,
    ...FALLBACK_PARAMS,
    output_config: { effort: "low", format: betaZodOutputFormat(LandmarkMatch) },
    messages: [{ role: "user", content }],
  });
  if (res.stop_reason === "refusal" || !res.parsed_output) {
    return { confidence_state: "UNKNOWN", selected_node_id: null, candidate_node_ids: [], landmark_id: null, evidence: "Could not analyze the scan." };
  }
  return decidePosition(res.parsed_output, landmarks, graph, previousNodeId);
}
