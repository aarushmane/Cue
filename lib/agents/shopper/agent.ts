// Shopper agent (Amazon Practical AI track): plans multi-step help — search → disambiguate → locate → route →
// guide → recover — by calling deterministic tools. Low effort keeps spoken replies fast.
import type Anthropic from "@anthropic-ai/sdk";
import type { Content, FunctionDeclaration, Part } from "@google/genai";
import { CLAUDE_MODEL, FALLBACK_PARAMS, getClaude } from "../../ai/claude";
import { GEMINI_MODEL, getGemini } from "../../ai/gemini";
import { aiProvider } from "../../ai/provider";
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
- This app supplements a cane, a guide dog and their own judgment. It does not detect obstacles; mention this once if they ask about safety.
- If asked about privacy: scans are used to find their position and to tell the store which products are on the shelves, as text only. Photos and voice are never saved, and they can turn product sharing off in settings.`;

const VERBOSITY = {
  concise: "Reply in at most one short sentence, or a few words. The shopper prefers brevity.",
  detailed: "Reply in up to three short sentences, with a little more context when it helps.",
} as const;

export interface ShopperTurnInput {
  nav: ShopperNav;
  /** Opaque, provider-specific history (Anthropic messages or Gemini contents) the client round-trips. */
  history: unknown[];
  utterance?: string;
  scan?: LocalizeResult; // result of a camera scan the app just completed via /api/localize
}

export interface ShopperTurnOutput {
  say: string; // text to speak: the verbatim route instructions when a step was read, otherwise the agent reply
  agent_text: string;
  route_text: string[];
  choices: string[];
  nav: ShopperNav;
  history: unknown[];
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

  const userText = parts.join("\n");
  // Rebuilt on every model call: tools change the state mid-turn.
  const stateLine = () => `${VERBOSITY[nav.prefs.verbosity]}\nCurrent app state: ${nav.state}. Product selected: ${nav.product_id ?? "none"}. Position: ${nav.position_confidence}.`;

  const { agentText, history } =
    aiProvider() === "gemini"
      ? await geminiLoop(input.history as Content[], userText, stateLine, ctx)
      : await claudeLoop(input.history as Msg[], userText, stateLine, ctx);

  // When a route step was read, speak ONLY the template text: models (especially small ones) tend to paraphrase
  // directions in their own words, which can contradict the computed route. agent_text is still returned for display.
  const say = ctx.spoken.length > 0 ? ctx.spoken.join(" ") : agentText;
  return { say, agent_text: agentText, route_text: ctx.spoken, choices: ctx.choices, nav: ctx.nav, history, reports: ctx.reports };
}

const REFUSAL_TEXT = "Sorry, I can't help with that. You can ask me to find a product.";

async function execTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<{ ok: true; out: unknown } | { ok: false; error: string }> {
  try {
    return { ok: true, out: await runShopperTool(name, args, ctx) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Tool failed" };
  }
}

// ───────────────────────────── Claude ─────────────────────────────
async function claudeLoop(history: Msg[], userText: string, stateLine: () => string, ctx: ToolContext) {
  const messages: Msg[] = [...trimHistory(history), { role: "user", content: userText }];
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
        { type: "text", text: stateLine() },
      ],
      tools: SHOPPER_TOOLS,
      messages,
    });
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "refusal") {
      agentText = REFUSAL_TEXT;
      break;
    }
    const text = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join(" ").trim();
    if (text) agentText = text;

    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

    // Tools touch shared nav state, so run them in order; return all results in ONE user message.
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const t of toolUses) {
      const r = await execTool(t.name, (t.input ?? {}) as Record<string, unknown>, ctx);
      results.push(
        r.ok
          ? { type: "tool_result", tool_use_id: t.id, content: JSON.stringify(r.out) }
          : { type: "tool_result", tool_use_id: t.id, is_error: true, content: r.error },
      );
    }
    messages.push({ role: "user", content: results });
  }
  return { agentText, history: messages as unknown[] };
}

// ───────────────────────────── Gemini ─────────────────────────────
const GEMINI_TOOLS: FunctionDeclaration[] = SHOPPER_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  parametersJsonSchema: t.input_schema,
}));

/** Same rule as trimHistory: cut only at a user turn made of plain text, never inside a call/response pair. */
function trimContents(history: Content[], max = 40): Content[] {
  if (history.length <= max) return history;
  let start = history.length - max;
  const plainUser = (c: Content) => c.role === "user" && (c.parts ?? []).every((p) => typeof p.text === "string");
  while (start < history.length && !plainUser(history[start])) start++;
  return start < history.length ? history.slice(start) : [];
}

async function geminiLoop(history: Content[], userText: string, stateLine: () => string, ctx: ToolContext) {
  const contents: Content[] = [...trimContents(history), { role: "user", parts: [{ text: userText }] }];
  let agentText = "";

  for (let i = 0; i < 6; i++) {
    const res = await getGemini().models.generateContent({
      model: GEMINI_MODEL,
      contents,
      config: { systemInstruction: `${SYSTEM}\n\n${stateLine()}`, tools: [{ functionDeclarations: GEMINI_TOOLS }], maxOutputTokens: 2000 },
    });
    const content = res.candidates?.[0]?.content;
    if (!content?.parts?.length) {
      // Blocked by a safety filter or empty: answer safely and stop.
      if (!agentText) agentText = REFUSAL_TEXT;
      break;
    }
    // Push the model turn back unchanged: Gemini 3 needs its thought signatures echoed on later turns.
    contents.push({ role: "model", parts: content.parts });

    const text = content.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join(" ").trim();
    if (text) agentText = text;

    const calls = content.parts.flatMap((p) => (p.functionCall?.name ? [p.functionCall] : []));
    if (calls.length === 0) break;

    const responses: Part[] = [];
    for (const call of calls) {
      const r = await execTool(call.name!, call.args ?? {}, ctx);
      responses.push({
        functionResponse: { id: call.id, name: call.name, response: r.ok ? { output: r.out } : { error: r.error } },
      });
    }
    contents.push({ role: "user", parts: responses });
  }
  return { agentText, history: contents as unknown[] };
}
