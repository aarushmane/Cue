// Rules shared by the onboarding demo entry points: the Server Function (lib/demo/onboard.ts) and the streaming
// route (app/api/agent/onboard/stream). Memory mode only, no staff session (demo). Not a "use server" module, so
// these helpers are plain functions, not callable Server Functions.
//
// Quota protection (a run makes about 10 model requests on a free-tier key):
// - ONBOARD_PASSCODE: when set, every demo run must send it (compared in constant time).
// - In production memory mode with no passcode, demo runs are refused: a deployed demo must set one.
// - One run at a time per server process (acquireOnboardingLock), for these entry points and the staff route.
// In Supabase mode the demo entry points refuse; POST /api/agent/onboard requires a signed-in staff member.
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { aiConfigured } from "../ai/provider";
import { DEFAULT_STORE_ID } from "../agents/onboarding/run-context";
import type { DemoFail } from "./types";

const Id = z.string().trim().min(1).max(200);
const StoreId = z.string().trim().min(1).max(100).regex(/^[\w-]+$/);

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time passcode check (hashing first makes both buffers the same length, so length isn't leaked either). */
export function passcodeMatches(given: unknown, expected: string): boolean {
  if (typeof given !== "string" || given.length > 200) return false;
  return timingSafeEqual(sha(given), sha(expected));
}

export function checkOnboardingRequest(
  propertyId: unknown, storeId: unknown = DEFAULT_STORE_ID, passcode?: unknown,
): { ok: true; propertyId: string; storeId: string } | DemoFail {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return { ok: false, status: 503, code: "BACKEND_NOT_CONNECTED", error: "Supabase is configured: run onboarding through POST /api/agent/onboard with a staff token." };
  }
  const expected = process.env.ONBOARD_PASSCODE;
  if (expected) {
    if (!passcodeMatches(passcode, expected)) {
      return { ok: false, status: 401, code: "PASSCODE", error: passcode ? "That passcode is not right." : "Enter the onboarding passcode to run the agent." };
    }
  } else if (process.env.NODE_ENV === "production") {
    return { ok: false, status: 503, code: "PASSCODE_NOT_SET", error: "Onboarding is turned off on this server. Set ONBOARD_PASSCODE to allow demo runs." };
  }
  if (!aiConfigured()) {
    return { ok: false, status: 503, code: "AI_NOT_CONFIGURED", error: "No AI provider is configured. Set GEMINI_API_KEY or ANTHROPIC_API_KEY in .env.local." };
  }
  const id = Id.safeParse(propertyId);
  if (!id.success) return { ok: false, status: 422, code: "INVALID", error: "Enter a CoStar property id or Matterport model id." };
  const store = StoreId.safeParse(storeId || DEFAULT_STORE_ID);
  if (!store.success) return { ok: false, status: 422, code: "INVALID", error: "Store ids use letters, numbers, - and _ only." };
  return { ok: true, propertyId: id.data, storeId: store.data };
}

// ───────────────────────────── One run at a time ─────────────────────────────

export const BUSY: DemoFail = { ok: false, status: 429, code: "BUSY", error: "Another onboarding run is in progress. Try again when it finishes." };

// Longer than any run can last (maxDuration is 300 s), so a lock leaked by a killed request can't block forever.
const STALE_MS = 6 * 60_000;
const KEY = Symbol.for("storeguide.onboardingLock");
type Holder = { since: number };
// On globalThis so dev-server module reloads share one lock.
const slot = globalThis as typeof globalThis & { [KEY]?: Holder | null };

/** Take the per-process onboarding lock. Returns a release function (safe to call twice), or null if a run holds it. */
export function acquireOnboardingLock(now = Date.now()): (() => void) | null {
  const held = slot[KEY];
  if (held && now - held.since < STALE_MS) return null;
  const mine: Holder = { since: now };
  slot[KEY] = mine;
  return () => {
    if (slot[KEY] === mine) slot[KEY] = null;
  };
}

export function onboardingFailure(err: unknown): DemoFail {
  const msg = err instanceof Error ? err.message : String(err);
  // Free-tier quota errors are common during development; say so plainly.
  const quota = /429|quota|RESOURCE_EXHAUSTED/i.test(msg);
  return {
    ok: false, status: 502, code: quota ? "QUOTA" : "ONBOARDING_FAILED",
    error: quota ? "The AI provider's free-tier limit was reached. Try again later or switch GEMINI_AGENT_MODEL." : `Onboarding failed: ${msg.slice(0, 300)}`,
  };
}
