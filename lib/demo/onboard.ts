"use server";
// DEMO ADAPTER for the staff onboarding screen: runs the onboarding deep agent server-side, so the staff token is
// never sent to the browser. Same rules as lib/demo/adapter.ts: no real staff session, refused when Supabase is
// configured (use POST /api/agent/onboard with a staff token there). Output is always a DRAFT; nothing publishes.
//
// The screen streams progress from POST /api/agent/onboard/stream (same rules, see ./onboard-guard) and falls back
// to this Server Function when the stream can't be opened.
import { runOnboarding, type OnboardingResult } from "../agents/onboarding/agent";
import { DEFAULT_STORE_ID } from "../agents/onboarding/run-context";
import { checkOnboardingRequest, onboardingFailure } from "./onboard-guard";
import type { DemoResult } from "./types";

export async function runOnboardingDemo(propertyId: string, storeId: string = DEFAULT_STORE_ID): Promise<DemoResult<{ result: OnboardingResult }>> {
  const req = checkOnboardingRequest(propertyId, storeId);
  if (!req.ok) return req;
  try {
    return { ok: true, result: await runOnboarding(req.propertyId, null, { store_id: req.storeId }) };
  } catch (err) {
    return onboardingFailure(err);
  }
}
