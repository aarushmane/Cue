import { aiConfigured } from "@/lib/ai/provider";
import { GEMINI_AGENT_MODEL, geminiModels, isQuotaError, markExhausted } from "@/lib/ai/gemini";
import { clientKey, createLimiter } from "@/lib/api/rateLimit";
import { runWayfinding } from "@/lib/agents/wayfinding/agent";
import { errorResponse, sceneFor, toStart, WayfindingBody } from "@/lib/wayfinding/request";
import { findInPhotos } from "@/lib/wayfinding/vision";

export const maxDuration = 120;

const limiter = createLimiter(Number(process.env.WAYFINDING_AGENT_RATE_LIMIT) || 20, 60_000);

// POST /api/wayfinding/agent — natural-language request ("where are the chips?") handled by the wayfinding deep
// agent. The reply is the agent's text; `plan` is the deterministic route it planned (drawn as arrows by the client).
export async function POST(request: Request) {
  if (!aiConfigured()) return Response.json({ error: "AGENT_UNAVAILABLE" }, { status: 503 });
  const rl = limiter.hit(clientKey(request));
  if (!rl.ok) return Response.json({ error: "RATE_LIMITED" }, { status: 429, headers: { "retry-after": String(rl.retryAfter) } });
  const parsed = WayfindingBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !parsed.data.query) {
    return Response.json({ error: "BAD_REQUEST", issues: parsed.success ? [{ message: "Send query." }] : parsed.error.issues.slice(0, 3) }, { status: 400 });
  }
  const body = parsed.data;
  try {
    const scene = await sceneFor(body);
    const result = await runWayfinding(scene, {
      query: body.query!, start: toStart(body.start, scene), detections: body.detections,
      searchPhotos: (query) => findInPhotos(scene, query),
    });
    return Response.json(result);
  } catch (error) {
    // Out of model quota: say so with 503, which makes the page answer through the deterministic route instead.
    if (isQuotaError(error)) {
      markExhausted(geminiModels(GEMINI_AGENT_MODEL)[0], error);
      return Response.json({ error: "AGENT_UNAVAILABLE" }, { status: 503 });
    }
    return errorResponse(error);
  }
}
