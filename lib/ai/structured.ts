// One structured-output vision call, on whichever provider is configured. Output is always validated
// against the zod schema in code; anything that fails validation, or a refusal, returns null.
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Part } from "@google/genai";
import { CLAUDE_MODEL, FALLBACK_PARAMS, getClaude, imageSource } from "./claude";
import { GEMINI_MODEL, getGemini, imagePart, toGeminiSchema } from "./gemini";
import { aiProvider } from "./provider";

/** Provider-neutral prompt piece: text, or an image as a data URL / raw base64 JPEG. */
export type Piece = { text: string } | { image: string };

export async function structuredVision<S extends z.ZodObject>(
  schema: S,
  pieces: Piece[],
  opts: { maxTokens: number; effort: "low" | "medium" | "high" },
): Promise<z.infer<S> | null> {
  const provider = aiProvider();

  if (provider === "anthropic") {
    const content = pieces.map((p) =>
      "text" in p ? { type: "text" as const, text: p.text } : { type: "image" as const, source: imageSource(p.image) },
    );
    const res = await getClaude().beta.messages.parse({
      model: CLAUDE_MODEL,
      max_tokens: opts.maxTokens,
      ...FALLBACK_PARAMS,
      output_config: { effort: opts.effort, format: betaZodOutputFormat(schema) },
      messages: [{ role: "user", content }],
    });
    if (res.stop_reason === "refusal" || !res.parsed_output) return null;
    return res.parsed_output as z.infer<S>;
  }

  if (provider === "gemini") {
    const parts: Part[] = pieces.map((p) => ("text" in p ? { text: p.text } : imagePart(p.image)));
    const res = await getGemini().models.generateContent({
      model: GEMINI_MODEL,
      contents: [{ role: "user", parts }],
      config: {
        maxOutputTokens: opts.maxTokens,
        responseMimeType: "application/json",
        responseJsonSchema: toGeminiSchema(z.toJSONSchema(schema) as Record<string, unknown>),
      },
    });
    const text = res.text;
    if (!text) return null;
    try {
      const parsed = schema.safeParse(JSON.parse(text));
      return parsed.success ? (parsed.data as z.infer<S>) : null;
    } catch {
      return null;
    }
  }

  throw new Error("No AI provider configured");
}
