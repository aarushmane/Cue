// Shared plumbing for the staff read routes: store_id from the query, staff check for THAT store, no caching.
import { requireStaff, type StaffCheck } from "../auth/requireStaff";

const STORE_ID = /^[\w-]{1,100}$/;
export const NO_STORE = { "Cache-Control": "private, no-store" };

export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

/** Resolve ?store_id= and authorize the caller for it. Returns the actor, or the error Response to send. */
export async function staffForStoreParam(request: Request): Promise<{ storeId: string; auth: Extract<StaffCheck, { ok: true }> } | Response> {
  const storeId = new URL(request.url).searchParams.get("store_id") ?? "";
  if (!STORE_ID.test(storeId)) return json({ code: "BAD_REQUEST", error: "store_id is required" }, 400);
  const auth = await requireStaff(request, storeId);
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  return { storeId, auth };
}
