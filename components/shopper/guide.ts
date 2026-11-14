// Client side of the shopper agent (POST /api/agent/shopper). The server is stateless: the app keeps `nav` and
// `history` and sends both back each turn. Pure helpers live here so they can be unit tested without React.
import type { LocalizeResult } from "@/lib/types";
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
      body: JSON.stringify({ nav, history, ...turn }),
      signal,
    });
  } catch {
    return { ok: false, offline: false, say: "I could not reach the assistant. Check your connection and try again." };
  }
  const body = (await r.json().catch(() => ({}))) as Partial<GuideReply> & { say?: string };
  if (r.status === 503) return { ok: false, offline: true, say: body.say ?? "The voice assistant is offline." };
  if (!r.ok || !body.nav) return { ok: false, offline: false, say: body.say ?? "Sorry, something went wrong. Please try again." };
  return { ok: true, reply: body as GuideReply };
}
