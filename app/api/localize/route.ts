import { z } from "zod";
import { claudeConfigured } from "@/lib/ai/claude";
import { getRepo } from "@/lib/db/repo";
import { matchLandmark } from "@/lib/vision/matchLandmark";

export const maxDuration = 60;

const MAX_FRAME_CHARS = 2_000_000; // ≈1.5 MB JPEG as base64

const Body = z.object({
  store_id: z.string().min(1).max(100),
  previous_node_id: z.string().max(100).nullable().optional(),
  lat: z.number().optional(), // coarse store context only; never treated as an indoor position
  lng: z.number().optional(),
  frames: z.array(z.string().max(MAX_FRAME_CHARS)).min(1).max(3), // data URLs (image/jpeg|png|webp)
});

// POST /api/localize — match 1–3 camera frames to a known landmark. Frames are processed in memory and never stored.
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "store_id and 1–3 frames are required" }, { status: 400 });
  const unknown = (evidence: string) => ({ confidence_state: "UNKNOWN", selected_node_id: null, candidate_node_ids: [], landmark_id: null, evidence });

  if (!claudeConfigured()) return Response.json(unknown("Visual localization is not configured on this server."), { status: 503 });

  const { store_id, previous_node_id, frames } = parsed.data;
  const repo = getRepo();
  const [graph, landmarks] = await Promise.all([repo.getPublishedGraph(store_id), repo.listLandmarks(store_id)]);
  if (!graph) return Response.json(unknown("This store has no published map."), { status: 404 });

  try {
    return Response.json(await matchLandmark({ frames, landmarks, graph, previousNodeId: previous_node_id }));
  } catch {
    return Response.json(unknown("The scan could not be analyzed. Try again."), { status: 502 });
  }
}
