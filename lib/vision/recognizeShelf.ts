// Shelf recognition (manual §07): propose candidate products visible in a shelf photo.
// Output is always NEEDS_REVIEW — candidates are suggestions, never published records.
import { z } from "zod";
import { structuredVision } from "../ai/structured";

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
  const out = await structuredVision(
    ShelfResult,
    [
      { image },
      {
        text:
          `List the distinct retail products visible on this shelf.${where} ` +
          "Use null for brand, variant or size unless the text is legible in the photo — do not infer them. " +
          "Ignore people. Mark confidence low when packaging is partly hidden or similar to another product.",
      },
    ],
    { maxTokens: 8000, effort: "medium" },
  );
  return out?.candidates ?? [];
}
