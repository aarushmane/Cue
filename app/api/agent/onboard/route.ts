import { z } from "zod";
import { claudeConfigured } from "@/lib/ai/claude";
import { runOnboarding } from "@/lib/agents/onboarding/agent";
import { requireStaff } from "@/lib/auth/requireStaff";

export const maxDuration = 300;

const Body = z.object({ costar_property_id: z.string().min(1).max(200) });

// POST /api/agent/onboard — staff only. Runs the onboarding deep agent and returns a DRAFT (never publishes).
export async function POST(request: Request) {
  const auth = await requireStaff(request, null);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!claudeConfigured()) return Response.json({ error: "ANTHROPIC_API_KEY is not set on the server." }, { status: 503 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "costar_property_id is required" }, { status: 400 });

  try {
    return Response.json(await runOnboarding(parsed.data.costar_property_id, auth.userId));
  } catch (err) {
    return Response.json({ error: "ONBOARDING_FAILED", detail: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
