import { z } from "zod";
import { requireStaff } from "@/lib/auth/requireStaff";
import { reviewSuggestion, suggestionStore } from "@/lib/inventory/store";

const Text = z.string().trim().max(200).nullable().optional();
const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve"),
    shelf_id: z.string().max(100).optional(), // default: the shelf most sightings placed it on
    level: z.enum(["top", "upper", "middle", "lower", "bottom"]).nullable().optional(),
    edits: z.object({ name: z.string().trim().min(1).max(200).optional(), brand: Text, variant: Text, size: Text, category: Text }).optional(),
    note: z.string().max(500).optional(),
  }),
  z.object({ action: z.literal("reject"), note: z.string().max(500).optional() }),
]);

// POST /api/inventory/suggestions/:id — staff approve (applies the change to the published list) or reject.
export async function POST(request: Request, ctx: RouteContext<"/api/inventory/suggestions/[id]">) {
  const { id } = await ctx.params;
  const storeId = await suggestionStore(id);
  if (!storeId) return Response.json({ error: "Suggestion not found." }, { status: 404 });
  const auth = await requireStaff(request, storeId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "BAD_REQUEST", issues: parsed.error.issues.slice(0, 3) }, { status: 400 });
  const { action, ...input } = parsed.data;

  const result = await reviewSuggestion(id, action, input, { userId: auth.userId, label: auth.label });
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ suggestion: result.suggestion, product_id: result.product_id });
}
