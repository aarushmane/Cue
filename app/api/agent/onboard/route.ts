import { z } from "zod";
import { aiConfigured } from "@/lib/ai/provider";
import { runOnboarding } from "@/lib/agents/onboarding/agent";
import { DEFAULT_STORE_ID } from "@/lib/agents/onboarding/run-context";
import { requireStaff } from "@/lib/auth/requireStaff";

export const maxDuration = 300;

const Body = z.object({ costar_property_id: z.string().min(1).max(200), store_id: z.string().min(1).max(100).optional() });

// POST /api/agent/onboard — staff only. Runs the onboarding deep agent and returns a DRAFT (never publishes).
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  // Suggestions are written to this store's Review queue, so the caller must be staff for it.
  const storeId = (parsed.success && parsed.data.store_id) || DEFAULT_STORE_ID;
  const auth = await requireStaff(request, storeId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!aiConfigured()) return Response.json({ error: "No AI provider configured (set GEMINI_API_KEY or ANTHROPIC_API_KEY)." }, { status: 503 });
  if (!parsed.success) return Response.json({ error: "costar_property_id is required" }, { status: 400 });

  try {
    return Response.json(await runOnboarding(parsed.data.costar_property_id, auth.userId, { store_id: storeId }));
  } catch (err) {
    return Response.json({ error: "ONBOARDING_FAILED", detail: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
