// Client side of the shopper agent (POST /api/agent/shopper). The server is stateless: the app keeps `nav` and
// `history` and sends both back each turn. Pure helpers live here so they can be unit tested without React.
import { DEMO_NODES } from "@/lib/seed/demo-store";
import type { LocalizeResult, MapNode } from "@/lib/types";
import type { Prefs } from "./ShopperProvider";

export type GuideState = "SEARCHING" | "DESTINATION_SELECTED" | "LOCATING" | "ROUTING" | "GUIDING" | "ARRIVED" | "NEEDS_HELP";

/** Mirrors `ShopperNav` in lib/agents/shopper/state.ts (kept structural so no server code is bundled). */
export interface GuideNav {
  store_id: string;
  state?: GuideState;
  product_id?: string | null;
  current_node_id?: string | null;
  position_confidence?: "CONFIRMED" | "LIKELY" | "UNKNOWN";
  prefs?: { verbosity: "concise" | "detailed"; speech_rate: number };
  [k: string]: unknown;
}

export interface GuideReply {
  say: string;
  agent_text: string;
  route_text: string[];
  choices: string[];
  ui_state: GuideState;
  nav: GuideNav;
  history: unknown[];
}

export interface GuideTurn {
  utterance?: string;
  scan?: LocalizeResult;
}

export type GuideResult =
  | { ok: true; reply: GuideReply }
  | { ok: false; offline: boolean; say: string };

const RATES: Prefs["rate"][] = [0.8, 1, 1.3];

/** The shopper's settings are the source of truth for verbosity and speech rate on every request. */
export function toNavPrefs(p: Pick<Prefs, "detail" | "rate">): NonNullable<GuideNav["prefs"]> {
  return { verbosity: p.detail, speech_rate: p.rate };
}

/** Snap the agent's speech rate (0.5–2) to the nearest rate the settings screen offers. */
export function nearestRate(r: number): Prefs["rate"] {
  return RATES.reduce((best, x) => (Math.abs(x - r) < Math.abs(best - r) ? x : best), 1 as Prefs["rate"]);
}

/** If the agent changed preferences (set_preferences), return the settings patch to apply; otherwise null. */
export function prefsPatch(sent: NonNullable<GuideNav["prefs"]>, got: GuideNav["prefs"]): Partial<Prefs> | null {
  if (!got) return null;
  const patch: Partial<Prefs> = {};
  if (got.verbosity !== sent.verbosity) patch.detail = got.verbosity;
  if (Math.abs(got.speech_rate - sent.speech_rate) > 1e-6) patch.rate = nearestRate(got.speech_rate);
  return Object.keys(patch).length ? patch : null;
}

/** Guiding states get Next / Repeat / Previous buttons (each sends a short utterance the agent maps to a tool). */
export const isGuiding = (s: GuideState | undefined) => s === "ROUTING" || s === "GUIDING";

/** States where the shopper must scan before any directions (unknown position means no turn-by-turn guidance). */
export const needsPosition = (nav: GuideNav) =>
  nav.state === "LOCATING" || (nav.state === "DESTINATION_SELECTED" && (nav.position_confidence ?? "UNKNOWN") === "UNKNOWN");

export async function postTurn(nav: GuideNav, history: unknown[], turn: GuideTurn, signal?: AbortSignal): Promise<GuideResult> {
  let r: Response;
  try {
    r = await fetch("/api/agent/shopper", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nav, history: trimForSend(history), ...turn }),
      signal,
    });
  } catch {
    return { ok: false, offline: false, say: "I could not reach the assistant. Check your connection and try again." };
  }
  const raw: unknown = await r.json().catch(() => null);
  const body = (raw && typeof raw === "object" ? raw : {}) as Partial<GuideReply>;
  if (r.status === 503) return { ok: false, offline: true, say: typeof body.say === "string" ? body.say : "The voice assistant is offline." };
  if (!r.ok || !body.nav || typeof body.nav.store_id !== "string" || typeof body.say !== "string" ||
    typeof body.agent_text !== "string" || !Array.isArray(body.history) ||
    !Array.isArray(body.route_text) || !body.route_text.every((t) => typeof t === "string") ||
    !Array.isArray(body.choices) || !body.choices.every((t) => typeof t === "string")) {
    return { ok: false, offline: false, say: typeof body.say === "string" ? body.say : "Sorry, something went wrong. Please try again." };
  }
  return { ok: true, reply: body as GuideReply };
}

/**
 * Position to keep when a new conversation starts ("New search", "Get directions"): the shopper is still where the
 * last scan or guided step put them. A CONFIRMED fix is downgraded to LIKELY, since they may have moved since.
 */
export function carryPosition(nav: GuideNav): Pick<GuideNav, "current_node_id" | "position_confidence"> | Record<string, never> {
  const conf = nav.position_confidence ?? "UNKNOWN";
  if (!nav.current_node_id || conf === "UNKNOWN") return {};
  return { current_node_id: nav.current_node_id, position_confidence: "LIKELY" };
}

/** The route accepts at most 80 history entries; stay well under it. */
export const MAX_SEND_HISTORY = 60;

/** A plain user text turn (Anthropic `{role:"user", content: string}` or Gemini `{role:"user", parts:[{text}]}`). */
function isPlainUserTurn(m: unknown): boolean {
  if (!m || typeof m !== "object") return false;
  const x = m as { role?: unknown; content?: unknown; parts?: unknown };
  if (x.role !== "user") return false;
  if (typeof x.content === "string") return true;
  return Array.isArray(x.parts) && x.parts.length > 0 && x.parts.every((p) => !!p && typeof (p as { text?: unknown }).text === "string" && Object.keys(p as object).length === 1);
}

/**
 * Bound the history the client sends. Cuts only at a plain user text turn, so a tool call is never separated from
 * its result (same rule as the server's trimHistory). With no safe cut point, start fresh: `nav` carries the state.
 */
export function trimForSend(history: unknown[], max = MAX_SEND_HISTORY): unknown[] {
  if (history.length <= max) return history;
  for (let i = history.length - max; i < history.length; i++) if (isPlainUserTurn(history[i])) return history.slice(i);
  return [];
}

// ───────────────────────────── Places, in words ─────────────────────────────

/** Spoken label of a map point, e.g. "the front of the walkway between Aisles 1 and 2". */
export const nodeLabel = (id: string | null | undefined, nodes: MapNode[] = DEMO_NODES) =>
  (id && nodes.find((n) => n.id === id)?.label) || null;

/** "near the entrance" (CONFIRMED), "probably near the entrance" (LIKELY), or null when the position is unknown. */
export function locationText(nav: GuideNav, nodes: MapNode[] = DEMO_NODES): string | null {
  const conf = nav.position_confidence ?? "UNKNOWN";
  const label = nodeLabel(nav.current_node_id, nodes);
  if (conf === "UNKNOWN" || !label) return null;
  return `${conf === "LIKELY" ? "probably near" : "near"} ${label}`;
}

/**
 * Where the help desk (node kind "service") is, in words, from its position on the plan. The plan is drawn with the
 * entrance at the bottom (front of the store), so y ≥ 0.5 is the front and x is left/right as you walk in.
 */
export function helpDeskText(nodes: MapNode[] = DEMO_NODES): string {
  const desk = nodes.find((n) => n.kind === "service");
  if (!desk) return "Ask any staff member for help.";
  const depth = desk.y >= 0.5 ? "at the front of the store" : "at the back of the store";
  const side = desk.x > 2 / 3 ? "on the far right as you come in" : desk.x < 1 / 3 ? "on the left as you come in" : "in the middle";
  return `The help desk is ${depth}, ${side}.`;
}
