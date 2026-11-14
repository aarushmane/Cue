import { requireStaff } from "@/lib/auth/requireStaff";
import { mapStore, publishMap } from "@/lib/staff/service";

// POST /api/maps/:id/publish — staff publish the saved draft as the next version (server re-runs mapChecks;
// 422 with failing labels). The previous version is superseded. Memory mode only for now (501 in Supabase mode).
export async function POST(request: Request, ctx: RouteContext<"/api/maps/[id]/publish">) {
  const { id } = await ctx.params;
  const storeId = await mapStore(id);
  if (!storeId) return Response.json({ code: "NOT_FOUND", error: "Map not found." }, { status: 404 });
  const auth = await requireStaff(request, storeId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const out = await publishMap(id);
  return Response.json(out.body, { status: out.status });
}
