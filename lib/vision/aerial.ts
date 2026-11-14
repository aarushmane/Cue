// Read a north-up Vexcel orthophoto for the outdoor approach: where the entrance and parking are. Advisory only:
// staff confirm, and the Matterport frame is not north-aligned, so this is never used to pick a node by itself.
import { z } from "zod";
import { structuredVision } from "../ai/structured";

export const AerialAnalysis = z.object({
  building_found: z.boolean(),
  entrance_side: z.enum(["north", "south", "east", "west", "unclear"]),
  parking: z.string(), // e.g. "surface lot along the south side, about 20 spaces"
  approach_notes: z.string(), // sidewalks, crossings, drop-off, curb cuts visible from above
  evidence: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
});
export type AerialAnalysis = z.infer<typeof AerialAnalysis>;

export async function analyzeAerial(imageDataUrl: string, ctx: { name: string; address: string; extentM: number | null }): Promise<AerialAnalysis | null> {
  return structuredVision(
    AerialAnalysis,
    [
      { image: imageDataUrl },
      {
        text:
          `North-up aerial orthophoto${ctx.extentM ? `, ${ctx.extentM} m across` : ""}, centered on ${ctx.name}, ${ctx.address}. ` +
          "The target building is at the center. For a blind shopper arriving on foot or by car, describe: which side of the building " +
          "the public entrance most likely faces (storefront glass, awnings, signage, sidewalk access), where parking and drop-off are, " +
          "and the walking approach from the street. Say unclear rather than guess; use low confidence if the roof hides the entrance.",
      },
    ],
    { maxTokens: 2000, effort: "medium" },
  );
}
