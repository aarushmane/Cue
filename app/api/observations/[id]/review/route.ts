import { z } from "zod";
import { requireStaff } from "@/lib/auth/requireStaff";
import { Draft } from "@/lib/demo/schemas";
import { observationStore, reviewObservation } from "@/lib/staff/service";

const Body = z.object({
  // "accept" and "edit" are the original contract's names for publish; both publish the reviewed draft.
  action: z.enum(["publish", "accept", "edit", "reject", "rescan"]),
  obs_version: z.number().int(),
  draft: Draft.optional(),
  target_version: z.number().int().nullable().optional(),
  reason: z.string().max(500).optional(),
});

// POST /api/observations/:id/review — staff publish / reject / rescan, all-or-nothing.
// Order: 404 → staff for the observation's store (401/403) → 400 → still NEEDS_REVIEW (409) → version (409)
// → validation (422) → merge target version (409) → one transaction.
export async function POST(request: Request, ctx: RouteContext<"/api/observations/[id]/review">) {
  const { id } = await ctx.params;
  const storeId = await observationStore(id);
  if (!storeId) return Response.json({ code: "NOT_FOUND", error: "Observation not found." }, { status: 404 });
  const auth = await requireStaff(request, storeId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ code: "BAD_REQUEST", issues: parsed.error.issues.slice(0, 3) }, { status: 400 });
  const { action, obs_version, draft, target_version, reason } = parsed.data;

  const out = await reviewObservation(
    id,
    { action: action === "accept" || action === "edit" ? "publish" : action, obsVersion: obs_version, draft, targetVersion: target_version, reason },
    { userId: auth.userId, label: auth.label },
  );
  return Response.json(out.body, { status: out.status });
}
