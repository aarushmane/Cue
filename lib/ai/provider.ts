// Which model provider the server uses. AI_PROVIDER=anthropic|gemini forces one; otherwise Anthropic is
// preferred when its key is set, then Gemini (free tier). "none" means AI routes return 503 and the app
// falls back to typed search and buttons.
import { claudeConfigured } from "./claude";
import { geminiConfigured } from "./gemini";

export type AIProvider = "anthropic" | "gemini" | "none";

export function aiProvider(): AIProvider {
  const forced = process.env.AI_PROVIDER?.toLowerCase();
  if (forced === "anthropic") return claudeConfigured() ? "anthropic" : "none";
  if (forced === "gemini") return geminiConfigured() ? "gemini" : "none";
  if (claudeConfigured()) return "anthropic";
  if (geminiConfigured()) return "gemini";
  return "none";
}

export function aiConfigured(): boolean {
  return aiProvider() !== "none";
}
