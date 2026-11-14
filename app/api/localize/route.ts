import { z } from "zod";
import { aiConfigured } from "@/lib/ai/provider";
import { getRepo } from "@/lib/db/repo";
import { matchLandmark } from "@/lib/vision/matchLandmark";
import { planScan } from "@/lib/inventory/reconcile";
import { applyScan } from "@/lib/inventory/store";

export const maxDuration = 60;

const MAX_FRAME_CHARS = 2_000_000; // ≈1.5 MB JPEG as base64

const Body = z.object({
  store_id: z.string().min(1).max(100),
  previous_node_id: z.string().max(100).nullable().optional(),
  lat: z.number().optional(), // coarse store context only; never treated as an indoor position
  lng: z.number().optional(),
  frames: z.array(z.string().max(MAX_FRAME_CHARS)).min(1).max(3), // data URLs (image/jpeg|png|webp)
  // Products seen in the frames feed the store's adaptive inventory (text only; frames are never stored).
  // The shopper app shows a notice and lets the shopper turn this off.
  share_sightings: z.boolean().default(true),
  // Node the shopper was guided to (e.g. ARRIVED at a shelf). Used ONLY to attribute product sightings to
  // shelves when the frames show no landmark; never used as a position for guidance.
  at_node_id: z.string().max(100).nullable().optional(),
});

// POST /api/localize — match 1–3 camera frames to a known landmark. Frames are processed in memory and never stored.
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "store_id and 1–3 frames are required" }, { status: 400 });
  const unknown = (evidence: string) => ({ confidence_state: "UNKNOWN", selected_node_id: null, candidate_node_ids: [], landmark_id: null, evidence });

  if (!aiConfigured()) return Response.json(unknown("Visual localization is not configured on this server."), { status: 503 });

  const { store_id, previous_node_id, frames, share_sightings, at_node_id } = parsed.data;
  const repo = getRepo();
  const [graph, landmarks] = await Promise.all([repo.getPublishedGraph(store_id), repo.listLandmarks(store_id)]);
  if (!graph) return Response.json(unknown("This store has no published map."), { status: 404 });

  try {
    const { products_seen, ...position } = await matchLandmark({ frames, landmarks, graph, previousNodeId: previous_node_id });
    let productsNoted = 0;
    // Only attribute sightings to a shelf when we know where the shopper is standing.
    const sightingNode = position.selected_node_id ?? (at_node_id && graph.nodes.some((n) => n.id === at_node_id) ? at_node_id : null);
    if (share_sightings && sightingNode && products_seen.length) {
      try {
        const plan = planScan({ sightings: products_seen, products: await repo.listPublishedProducts(store_id), graph, nodeId: sightingNode });
        await applyScan(store_id, plan);
        productsNoted = plan.confirmed.length + plan.deltas.filter((d) => d.kind !== "MISSING").length;
      } catch (err) {
        // Inventory updates must never break localization for the shopper.
        console.error("inventory sighting failed:", err instanceof Error ? err.message.slice(0, 300) : "unknown error");
      }
    }
    return Response.json({ ...position, products_noted: productsNoted });
  } catch (err) {
    // Log the reason only; frames are never logged.
    console.error("localize failed:", err instanceof Error ? err.message.slice(0, 500) : "unknown error");
    return Response.json(unknown("The scan could not be analyzed. Try again."), { status: 502 });
  }
}
