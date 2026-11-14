import { requireStaff } from "@/lib/auth/requireStaff";
import { Plan } from "@/lib/demo/schemas";
import { mapStore, saveMapDraft } from "@/lib/staff/service";
import type { FloorPlan } from "@/lib/types";

// PUT /api/maps/:id/graph — staff save the floor plan editor's draft (never published by this call).
// Body: the editor's FloorPlan (nodes, edges, shelves, landmarks). Memory mode only for now (501 in Supabase mode).
export async function PUT(request: Request, ctx: RouteContext<"/api/maps/[id]/graph">) {
  const { id } = await ctx.params;
  const storeId = await mapStore(id);
  if (!storeId) return Response.json({ code: "NOT_FOUND", error: "Map not found." }, { status: 404 });
  const auth = await requireStaff(request, storeId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const parsed = Plan.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ code: "BAD_REQUEST", issues: parsed.error.issues.slice(0, 3) }, { status: 400 });
  const out = await saveMapDraft(id, parsed.data as FloorPlan);
  return Response.json(out.body, { status: out.status });
}
