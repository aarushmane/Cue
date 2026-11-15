import { z } from "zod";
import { aiConfigured } from "@/lib/ai/provider";
import { runVoiceAgent } from "@/lib/agents/voice/agent";
import { errorResponse, sceneFor, toStart, WayfindingBody } from "@/lib/wayfinding/request";
import { findInPhotos } from "@/lib/wayfinding/vision";
import { voiceGuard } from "@/lib/voice/elevenlabs";

export const maxDuration = 120;
const Body = WayfindingBody.extend({
  query: z.string().trim().min(1).max(300),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(2000) })).max(8).default([]),
  current_item_id: z.string().max(100).optional(),
  heading_deg: z.number().finite().min(-360).max(360).optional(),
});

export async function POST(request: Request) {
  const blocked = voiceGuard(request);
  if (blocked) return blocked;
  if (!aiConfigured()) return Response.json({ error: "Configure ANTHROPIC_API_KEY or GEMINI_API_KEY for voice reasoning." }, { status: 503 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid voice request." }, { status: 400 });
  const body = parsed.data;
  try {
    const scene = await sceneFor(body);
    request.signal.throwIfAborted();
    const result = await runVoiceAgent(scene, {
      query: body.query, start: toStart(body.start, scene), history: body.history, currentItemId: body.current_item_id,
      signal: request.signal, searchPhotos: (query) => findInPhotos(scene, query),
      headingDeg: body.heading_deg,
    });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return errorResponse(error);
  }
}
