// Visual localization (manual §08): match shopper camera frames against the store's known landmarks.
// The model only *classifies* which landmark is visible; confidence → CONFIRMED / LIKELY / UNKNOWN is decided
// here in code, together with map adjacency to the previous position. Frames are never stored or logged.
import { z } from "zod";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveImage } from "../ai/images";
import { structuredVision, type Piece } from "../ai/structured";
import type { Landmark, LocalizeResult, StoreGraph } from "../types";

const LandmarkMatch = z.object({
  landmark_id: z.string().nullable(), // one of the provided ids, or null when none is clearly visible
  confidence: z.enum(["high", "medium", "low"]),
  evidence: z.string(), // what in the frame supports the match, e.g. "blue sign reading AISLE 2 – DAIRY"
});
export type LandmarkMatch = z.infer<typeof LandmarkMatch>;

// Products visible in the same frames feed the adaptive inventory (lib/inventory). Same call, no extra request.
const ProductSeen = z.object({
  name: z.string(),
  brand: z.string().nullable(),
  variant: z.string().nullable(),
  size: z.string().nullable(),
  category: z.string().nullable(), // product type, e.g. "plant-based milk"
  evidence: z.string(), // legible text / packaging supporting it
  confidence: z.enum(["high", "medium", "low"]),
});
// No .max() on the array: Gemini rejects maxItems on arrays of objects this size (400 INVALID_ARGUMENT).
// The cap is applied in code instead.
const ScanReading = LandmarkMatch.extend({ products_seen: z.array(ProductSeen) });
const MAX_PRODUCTS_PER_SCAN = 40;
export type ProductSeen = z.infer<typeof ProductSeen>;

export type ScanResult = LocalizeResult & { products_seen: ProductSeen[] };

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

// ───────────────────────────── Reference photos ─────────────────────────────
// Each landmark can carry a reference photo (`imageUrl`): a file under public/ (e.g. "/demo/landmarks/L01.jpg")
// or a Matterport panorama https URL. Photos make matching more reliable but cost tokens on every scan, so:
// - a missing, unreadable, oversized or unsupported file is skipped (the text description is still used) and
//   reported once in the server log (path only);
// - local files are cached in memory; a miss is re-checked after a minute, so photos added later are picked up;
// - remote panoramas are fetched here, so an expired signed link drops only that reference instead of failing the
//   whole scan;
// - LANDMARK_REFERENCE_IMAGES=off sends descriptions only (saves quota).

const REF_MAX_BYTES = 1_500_000; // same order as one shopper frame
const MISS_TTL_MS = 60_000;
const REMOTE_TTL_MS = 10 * 60_000; // Matterport signed links last about an hour
const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

type Cached = { value: string | null; at: number };
const refCache = new Map<string, Cached>();
const warned = new Set<string>();
function warnOnce(key: string, msg: string) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[localize] ${msg}`);
}

/** Exported for tests. `root` is the folder public URLs resolve against (default: ./public). */
export async function referenceImage(url: string | null, root = path.join(process.cwd(), "public")): Promise<string | null> {
  if (!url || process.env.LANDMARK_REFERENCE_IMAGES === "off") return null;
  const key = `${root}|${url}`;
  const hit = refCache.get(key);
  const ttl = hit?.value ? (url.startsWith("https://") ? REMOTE_TTL_MS : Infinity) : MISS_TTL_MS;
  if (hit && Date.now() - hit.at < ttl) return hit.value;

  let value: string | null = null;
  if (url.startsWith("https://")) {
    try {
      value = await resolveImage(url); // host-restricted (Matterport CDN), type- and size-checked
    } catch (err) {
      warnOnce(key, `reference ${url.split("?")[0]} skipped: ${err instanceof Error ? err.message : "fetch failed"}`);
    }
  } else if (url.startsWith("/") && !url.includes("..")) {
    const mime = MIME[path.extname(url).toLowerCase()];
    if (!mime) warnOnce(key, `reference ${url} skipped: use .jpg, .png or .webp`);
    else {
      try {
        const buf = await readFile(path.join(root, url));
        if (buf.length > REF_MAX_BYTES) warnOnce(key, `reference ${url} skipped: ${Math.round(buf.length / 1000)} KB is over ${REF_MAX_BYTES / 1000} KB (resize it)`);
        else value = `data:${mime};base64,${buf.toString("base64")}`;
      } catch {
        warnOnce(key, `reference photo ${url} not found: matching uses the text description only`);
      }
    }
  }
  refCache.set(key, { value, at: Date.now() });
  return value;
}

export async function matchLandmark(args: {
  frames: string[]; // data URLs or base64 JPEG
  landmarks: Landmark[];
  graph: StoreGraph;
  previousNodeId?: string | null;
}): Promise<ScanResult> {
  const { frames, landmarks, graph, previousNodeId } = args;
  if (landmarks.length === 0) {
    return { confidence_state: "UNKNOWN", selected_node_id: null, candidate_node_ids: [], landmark_id: null, evidence: "This store has no reference landmarks yet.", products_seen: [] };
  }
  const near = adjacentNodeIds(graph, previousNodeId);
  const ordered = [...landmarks].sort((a, b) => Number(near.has(b.nodeId)) - Number(near.has(a.nodeId)));

  const refs = await Promise.all(ordered.map((l) => referenceImage(l.imageUrl)));
  const content: Piece[] = [{ text: "Reference landmarks for this store:" }];
  ordered.forEach((l, i) => {
    content.push({ text: `Landmark ${l.id}: ${l.description}${refs[i] ? " (reference photo follows)" : ""}` });
    if (refs[i]) content.push({ image: refs[i]! });
  });
  content.push({ text: `Shopper camera frames (${frames.length}):` });
  for (const f of frames) content.push({ image: f });
  content.push({
    text:
      "Which single reference landmark is clearly visible in the shopper frames? Answer with its id, or null if none is clearly visible. " +
      "Use high confidence only when distinctive text or a unique feature matches. Never guess between two similar landmarks — answer null instead. " +
      "Also list in products_seen each distinct retail product visible on shelves in the shopper frames: name, brand, variant, size and " +
      "product type (category). Use null for any field whose text is not legible; do not infer it. Ignore people. Low confidence when packaging is partly hidden.",
  });

  const reading = await structuredVision(ScanReading, content, { maxTokens: 4000, effort: "low" });
  if (!reading) {
    return { confidence_state: "UNKNOWN", selected_node_id: null, candidate_node_ids: [], landmark_id: null, evidence: "Could not analyze the scan.", products_seen: [] };
  }
  const { products_seen, ...match } = reading;
  return { ...decidePosition(match, landmarks, graph, previousNodeId), products_seen: products_seen.slice(0, MAX_PRODUCTS_PER_SCAN) };
}
