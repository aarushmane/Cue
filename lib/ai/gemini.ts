// Shared Gemini client (free-tier fallback when there is no Anthropic key). Server-only.
import { GoogleGenAI, type Part } from "@google/genai";
import { imageSource } from "./claude";

export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
/** The long onboarding run benefits from a stronger model; falls back to GEMINI_MODEL. */
export const GEMINI_AGENT_MODEL = process.env.GEMINI_AGENT_MODEL || GEMINI_MODEL;

/**
 * Models to fall back to, in order, when one has used up its quota (free-tier limits are per model per day).
 * Comma-separated; set GEMINI_FALLBACK_MODELS="" to disable.
 */
const FALLBACKS = (process.env.GEMINI_FALLBACK_MODELS ?? "gemini-3.5-flash-lite").split(",").map((m) => m.trim()).filter(Boolean);

// Model → time its quota should be back (from the error's retry delay; an hour if it doesn't say).
const exhausted = new Map<string, number>();

/** True for "quota exceeded" errors (429 / RESOURCE_EXHAUSTED), which another model may not have. */
export function isQuotaError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${(error as { status?: unknown }).status ?? ""}` : String(error);
  return /RESOURCE_EXHAUSTED|exceeded your current quota|\b429\b/.test(text);
}

/** Remember that `model` is out of quota until its retry delay passes. */
export function markExhausted(model: string, error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  const delay = /retryDelay"?:\s*"(\d+)s"/.exec(text)?.[1] ?? /retry in (?:(\d+)h)?(?:(\d+)m)?/.exec(text)?.slice(1).reduce((s, v, i) => s + (Number(v) || 0) * (i ? 60 : 3600), 0);
  const seconds = Number(delay) > 0 ? Number(delay) : 3600;
  exhausted.set(model, Date.now() + seconds * 1000);
  console.warn(`gemini: ${model} is out of quota for ~${Math.round(seconds / 60)} min; using fallbacks`);
}

/** The configured model first, then the fallbacks, skipping any still out of quota. */
export function geminiModels(primary = GEMINI_MODEL): string[] {
  const all = [...new Set([primary, ...FALLBACKS])];
  const ready = all.filter((m) => (exhausted.get(m) ?? 0) <= Date.now());
  return ready.length ? ready : all; // all exhausted: try anyway (a limit may have reset early)
}

let client: GoogleGenAI | null = null;

export function geminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

export function getGemini(): GoogleGenAI {
  // Retry transient overloads ("high demand" 503s are common on the free tier); short delays keep voice turns snappy.
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { retryOptions: { attempts: 3, initialDelay: 1, maxDelay: 4 } } });
  return client;
}

/** A data: URL or raw base64 image as a Gemini inline-data part. */
export function imagePart(dataUrlOrBase64: string): Part {
  const s = imageSource(dataUrlOrBase64);
  return { inlineData: { mimeType: s.media_type, data: s.data } };
}

/** Plain JSON Schema for Gemini: drop the `$schema` key zod adds. */
export function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = schema;
  void _ignored;
  return rest;
}
