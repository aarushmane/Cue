// Shelf recognition (manual §07): propose candidate products visible in a shelf photo.
// Output is always NEEDS_REVIEW — candidates are suggestions, never published records.
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { CLAUDE_MODEL, FALLBACK_PARAMS, getClaude, imageSource } from "../ai/claude";

export const ShelfCandidate = z.object({
  name: z.string(),
  brand: z.string().nullable(),
  variant: z.string().nullable(),
  size: z.string().nullable(),
  evidence: z.string(), // visible text / packaging that supports the identification
  confidence: z.enum(["high", "medium", "low"]),
});
export type ShelfCandidate = z.infer<typeof ShelfCandidate>;

const ShelfResult = z.object({ candidates: z.array(ShelfCandidate) });

export async function recognizeShelf(image: string, context?: { aisle?: string; section?: string }): Promise<ShelfCandidate[]> {
  const where = context?.aisle ? ` The photo was taken at Aisle ${context.aisle}${context.section ? `, section ${context.section}` : ""}.` : "";
  const res = await getClaude().beta.messages.parse({
    model: CLAUDE_MODEL,
    max_tokens: 8000,
    ...FALLBACK_PARAMS,
    output_config: { effort: "medium", format: betaZodOutputFormat(ShelfResult) },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: imageSource(image) },
          {
            type: "text",
            text:
              `List the distinct retail products visible on this shelf.${where} ` +
              "Use null for brand, variant or size unless the text is legible in the photo — do not infer them. " +
              "Ignore people. Mark confidence low when packaging is partly hidden or similar to another product.",
          },
        ],
      },
    ],
  });
  if (res.stop_reason === "refusal" || !res.parsed_output) return [];
  return res.parsed_output.candidates;
}
