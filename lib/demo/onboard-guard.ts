// Rules shared by the onboarding demo entry points: the Server Function (lib/demo/onboard.ts) and the streaming
// route (app/api/agent/onboard/stream). Memory mode only, no staff session (demo). Not a "use server" module, so
// these helpers are plain functions, not callable Server Functions.
import { z } from "zod";
import { aiConfigured } from "../ai/provider";
import { DEFAULT_STORE_ID } from "../agents/onboarding/run-context";
import type { DemoFail } from "./types";

const Id = z.string().trim().min(1).max(200);
const StoreId = z.string().trim().min(1).max(100).regex(/^[\w-]+$/);

export function checkOnboardingRequest(propertyId: unknown, storeId: unknown = DEFAULT_STORE_ID): { ok: true; propertyId: string; storeId: string } | DemoFail {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return { ok: false, status: 503, code: "BACKEND_NOT_CONNECTED", error: "Supabase is configured: run onboarding through POST /api/agent/onboard with a staff token." };
  }
  if (!aiConfigured()) {
    return { ok: false, status: 503, code: "AI_NOT_CONFIGURED", error: "No AI provider is configured. Set GEMINI_API_KEY or ANTHROPIC_API_KEY in .env.local." };
  }
  const id = Id.safeParse(propertyId);
  if (!id.success) return { ok: false, status: 422, code: "INVALID", error: "Enter a CoStar property id or Matterport model id." };
  const store = StoreId.safeParse(storeId ?? DEFAULT_STORE_ID);
  if (!store.success) return { ok: false, status: 422, code: "INVALID", error: "Invalid store id." };
  return { ok: true, propertyId: id.data, storeId: store.data };
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
