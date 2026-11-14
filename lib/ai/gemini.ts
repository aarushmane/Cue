// Shared Gemini client (free-tier fallback when there is no Anthropic key). Server-only.
import { GoogleGenAI, type Part } from "@google/genai";
import { imageSource } from "./claude";

export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
/** The long onboarding run benefits from a stronger model; falls back to GEMINI_MODEL. */
export const GEMINI_AGENT_MODEL = process.env.GEMINI_AGENT_MODEL || GEMINI_MODEL;

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
