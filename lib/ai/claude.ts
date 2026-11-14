// Shared Claude client. Server-only: API keys never reach the browser.
import Anthropic from "@anthropic-ai/sdk";

export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

// Server-side refusal fallback: if a safety classifier declines, the API retries on a suitable model
// inside the same call. "default" routes by refusal category, so there is no model list to maintain.
export const FALLBACK_PARAMS: { betas: Anthropic.Beta.AnthropicBeta[]; fallbacks: "default" } = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
};

let client: Anthropic | null = null;

export function claudeConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export function getClaude(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

/** Read a data: URL or raw base64 JPEG/PNG into an image block source. */
export function imageSource(dataUrlOrBase64: string): { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/webp"; data: string } {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([\s\S]*)$/.exec(dataUrlOrBase64);
  if (m) return { type: "base64", media_type: m[1] as "image/jpeg" | "image/png" | "image/webp", data: m[2] };
  return { type: "base64", media_type: "image/jpeg", data: dataUrlOrBase64 };
}
