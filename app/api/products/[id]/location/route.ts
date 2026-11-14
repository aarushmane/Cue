import { z } from "zod";
import { requireStaff } from "@/lib/auth/requireStaff";
import { Level } from "@/lib/demo/schemas";
import { moveProduct, productStore } from "@/lib/staff/service";

const Body = z.object({
  shelf_id: z.string().min(1).max(100),
  level: Level,
  // Optional optimistic concurrency: the product version the employee saw. 409 if it changed.
  expected_version: z.number().int().optional(),
});

// PATCH /api/products/:id/location — staff move (move_product: supersede, insert, audit in one transaction).
export async function PATCH(request: Request, ctx: RouteContext<"/api/products/[id]/location">) {
  const { id } = await ctx.params;
  const storeId = await productStore(id);
  if (!storeId) return Response.json({ code: "NOT_FOUND", error: "Product not found." }, { status: 404 });
  const auth = await requireStaff(request, storeId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ code: "BAD_REQUEST", issues: parsed.error.issues.slice(0, 3) }, { status: 400 });
  const { shelf_id, level, expected_version } = parsed.data;
  const out = await moveProduct(id, shelf_id, level, expected_version, { userId: auth.userId, label: auth.label });
  return Response.json(out.body, { status: out.status });
}
