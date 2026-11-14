// Shopper agent (Amazon Practical AI track): plans multi-step help — search → disambiguate → locate → route →
// guide → recover — by calling deterministic tools. Low effort keeps spoken replies fast.
import type Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MODEL, FALLBACK_PARAMS, getClaude } from "../../ai/claude";
import type { LocalizeResult } from "../../types";
import type { ShopperNav } from "./state";
import { runShopperTool, SHOPPER_TOOLS, type ToolContext } from "./tools";

type Msg = Anthropic.Beta.BetaMessageParam;

const SYSTEM = `You are StoreGuide, a voice assistant that helps blind and low-vision shoppers find products inside one store.
Everything you write is read aloud by text-to-speech, so write plain spoken sentences: no lists, markdown, emoji or symbols.

How you work:
- Find products only with search_products. If several variants match, read the options briefly and ask which one. Never pick a variant for the shopper.
- Directions come only from start_route, next_step, repeat_step and previous_step. The app reads each instruction aloud word for word right after your reply, so never write, restate or paraphrase directions, distances, turns or shelf positions yourself.
- Without a CONFIRMED or LIKELY position you must not give any guidance. Ask the shopper to tap Scan and slowly pan their phone left to right.
- When the shopper says things like "done", "okay", "next" or "I'm here" while being guided, call next_step. "Again" or "what?" means repeat_step.
- If the product isn't there or something is wrong, offer report_issue. If they want a person, or no route exists, use request_help.
- If they ask you to talk less, more, slower or faster, call set_preferences.
- This app supplements a cane, a guide dog and their own judgment. It does not detect obstacles; mention this once if they ask about safety.`;

const VERBOSITY = {
  concise: "Reply in at most one short sentence, or a few words. The shopper prefers brevity.",
  detailed: "Reply in up to three short sentences, with a little more context when it helps.",
} as const;

export interface ShopperTurnInput {
  nav: ShopperNav;
  history: Msg[];
  utterance?: string;
  scan?: LocalizeResult; // result of a camera scan the app just completed via /api/localize
}

export interface ShopperTurnOutput {
  say: string; // full text to speak: agent reply + verbatim route instructions
  agent_text: string;
  route_text: string[];
  choices: string[];
  nav: ShopperNav;
  history: Msg[];
  reports: ToolContext["reports"];
}

/** Keep history bounded without splitting a tool_use/tool_result pair: cut only at a plain user text turn. */
function trimHistory(history: Msg[], max = 40): Msg[] {
  if (history.length <= max) return history;
  let start = history.length - max;
  while (start < history.length && !(history[start].role === "user" && typeof history[start].content === "string")) start++;
  return start < history.length ? history.slice(start) : [];
}

export async function runShopperTurn(input: ShopperTurnInput): Promise<ShopperTurnOutput> {
  const nav = structuredClone(input.nav);
  const ctx: ToolContext = { nav, spoken: [], choices: [], reports: [] };

  // A scan result updates position in code; the model is told what happened.
  const parts: string[] = [];
  if (input.scan) {
    if (input.scan.confidence_state !== "UNKNOWN" && input.scan.selected_node_id) {
      nav.current_node_id = input.scan.selected_node_id;
      nav.position_confidence = input.scan.confidence_state;
      if (nav.state === "LOCATING") nav.state = nav.product_id ? "DESTINATION_SELECTED" : "SEARCHING";
    } else {
      nav.position_confidence = "UNKNOWN";
    }
    parts.push(`[The app finished a camera scan. Position: ${nav.position_confidence}${input.scan.selected_node_id ? `, node ${input.scan.selected_node_id}` : ""}. Evidence: ${input.scan.evidence}]`);
  }
  if (input.utterance?.trim()) parts.push(input.utterance.trim().slice(0, 500));
  if (parts.length === 0) parts.push("[The shopper opened the app.]");

  const messages: Msg[] = [...trimHistory(input.history), { role: "user", content: parts.join("\n") }];
  const client = getClaude();
  let agentText = "";

  for (let i = 0; i < 6; i++) {
    const response = await client.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 4000,
      ...FALLBACK_PARAMS,
      output_config: { effort: "low" },
      system: [
        { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
        { type: "text", text: `${VERBOSITY[nav.prefs.verbosity]}\nCurrent app state: ${nav.state}. Product selected: ${nav.product_id ?? "none"}. Position: ${nav.position_confidence}.` },
      ],
      tools: SHOPPER_TOOLS,
      messages,
    });
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "refusal") {
      agentText = "Sorry, I can't help with that. You can ask me to find a product.";
      break;
    }
    const text = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join(" ").trim();
    if (text) agentText = text;

    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

    // Tools touch shared nav state, so run them in order; return all results in ONE user message.
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const t of toolUses) {
      try {
        const out = await runShopperTool(t.name, (t.input ?? {}) as Record<string, unknown>, ctx);
        results.push({ type: "tool_result", tool_use_id: t.id, content: JSON.stringify(out) });
      } catch (err) {
        results.push({ type: "tool_result", tool_use_id: t.id, is_error: true, content: err instanceof Error ? err.message : "Tool failed" });
      }
    }
    messages.push({ role: "user", content: results });
  }

  const say = [agentText, ...ctx.spoken].filter(Boolean).join(" ");
  return { say, agent_text: agentText, route_text: ctx.spoken, choices: ctx.choices, nav, history: messages, reports: ctx.reports };
}
