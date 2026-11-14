"use server";
// DEMO ADAPTER for the staff onboarding screen: runs the onboarding deep agent server-side, so the staff token is
// never sent to the browser. Same rules as lib/demo/adapter.ts: no real staff session, refused when Supabase is
// configured (use POST /api/agent/onboard with a staff token there). Output is always a DRAFT; nothing publishes.
import { z } from "zod";
import { aiConfigured } from "../ai/provider";
import { runOnboarding, type OnboardingResult } from "../agents/onboarding/agent";
import type { DemoResult } from "./types";

const Id = z.string().trim().min(1).max(200);

export async function runOnboardingDemo(propertyId: string): Promise<DemoResult<{ result: OnboardingResult }>> {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return { ok: false, status: 503, code: "BACKEND_NOT_CONNECTED", error: "Supabase is configured: run onboarding through POST /api/agent/onboard with a staff token." };
  }
  if (!aiConfigured()) {
    return { ok: false, status: 503, code: "AI_NOT_CONFIGURED", error: "No AI provider is configured. Set GEMINI_API_KEY or ANTHROPIC_API_KEY in .env.local." };
  }
  const id = Id.safeParse(propertyId);
  if (!id.success) return { ok: false, status: 422, code: "INVALID", error: "Enter a CoStar property id or Matterport model id." };
  try {
    return { ok: true, result: await runOnboarding(id.data, null) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Free-tier quota errors are common during development; say so plainly.
    const quota = /429|quota|RESOURCE_EXHAUSTED/i.test(msg);
    return {
      ok: false, status: 502, code: quota ? "QUOTA" : "ONBOARDING_FAILED",
      error: quota ? "The AI provider's free-tier limit was reached. Try again later or switch GEMINI_AGENT_MODEL." : `Onboarding failed: ${msg.slice(0, 300)}`,
    };
  }
}
