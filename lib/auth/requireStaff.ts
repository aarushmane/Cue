// Staff authorization for mutation routes (manual §10/§14, test P01).
// Supabase mode: `Authorization: Bearer <supabase access token>` + a store_staff row for the store.
// Memory mode (no Supabase, no sign-in, in-memory demo data only):
//   - `Authorization: Bearer $STAFF_DEMO_TOKEN` (scripts, API tests), or
//   - no Authorization header from a same-origin browser page: the manager app itself. This is the same protection
//     Next gives the Server Functions these routes replaced (an Origin check against cross-site requests); memory
//     mode has never had staff identities. Any other request without a valid token gets 401.
import { createClient } from "@supabase/supabase-js";
import { getAdminDb } from "../db/admin";

export type StaffCheck = { ok: true; userId: string | null; label: string } | { ok: false; status: 401 | 403; error: string };

const DEMO_STAFF_OK: StaffCheck = { ok: true, userId: null, label: "demo-staff" };

/**
 * True for a request a browser sent from one of this app's own pages. Sec-Fetch-Site and Origin are set by the
 * browser and can't be changed by page scripts, so another site can't make a browser send a request that passes.
 * (A non-browser client can send anything, which is why this is accepted only in memory mode.)
 */
function sameOriginBrowser(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function requireStaff(request: Request, storeId: string | null): Promise<StaffCheck> {
  const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anon) {
    if (!token) return sameOriginBrowser(request) ? DEMO_STAFF_OK : { ok: false, status: 401, error: "Sign in as store staff." };
    const demo = process.env.STAFF_DEMO_TOKEN;
    return demo && token === demo ? DEMO_STAFF_OK : { ok: false, status: 401, error: "Invalid staff token." };
  }

  if (!token) return { ok: false, status: 401, error: "Sign in as store staff." };
  const { data, error } = await createClient(url, anon, { auth: { persistSession: false } }).auth.getUser(token);
  if (error || !data.user) return { ok: false, status: 401, error: "Session expired. Sign in again." };
  if (storeId) {
    const db = getAdminDb();
    if (!db) return { ok: false, status: 403, error: "Server is missing SUPABASE_SERVICE_ROLE_KEY." };
    const { data: row } = await db.from("store_staff").select("role").eq("store_id", storeId).eq("user_id", data.user.id).maybeSingle();
    if (!row) return { ok: false, status: 403, error: "You are not staff for this store." };
  }
  return { ok: true, userId: data.user.id, label: data.user.email ?? data.user.id };
}
