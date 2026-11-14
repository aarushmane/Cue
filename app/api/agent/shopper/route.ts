import { z } from "zod";
import { claudeConfigured } from "@/lib/ai/claude";
import { runShopperTurn } from "@/lib/agents/shopper/agent";
import { ShopperNav } from "@/lib/agents/shopper/state";
import { saveShopperReports } from "@/lib/db/writes";

export const maxDuration = 60;

const Body = z.object({
  nav: ShopperNav,
  history: z.array(z.any()).max(80).default([]), // Anthropic message params, round-tripped unchanged
  utterance: z.string().max(500).optional(),
  scan: z
    .object({
      confidence_state: z.enum(["CONFIRMED", "LIKELY", "UNKNOWN"]),
      selected_node_id: z.string().nullable(),
      candidate_node_ids: z.array(z.string()),
      landmark_id: z.string().nullable(),
      evidence: z.string().max(1000),
    })
    .optional(),
});

// POST /api/agent/shopper — one conversational turn. The client keeps `nav` and `history` and sends them back.
export async function POST(request: Request) {
  if (!claudeConfigured()) {
    return Response.json({ error: "AGENT_UNAVAILABLE", say: "The voice assistant is offline. You can still type a product name and use the buttons." }, { status: 503 });
  }
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "BAD_REQUEST", issues: parsed.error.issues.slice(0, 3) }, { status: 400 });

  try {
    const out = await runShopperTurn(parsed.data);
    await saveShopperReports(out.nav.store_id, out.reports);
    return Response.json({
      say: out.say,
      agent_text: out.agent_text,
      route_text: out.route_text,
      choices: out.choices,
      ui_state: out.nav.state,
      nav: out.nav,
      history: out.history,
    });
  } catch {
    return Response.json({ error: "AGENT_ERROR", say: "Sorry, something went wrong. Please try again, or use the buttons." }, { status: 502 });
  }
}
