// Staff authorization for mutation routes (manual §10/§14, test P01).
// Supabase mode: `Authorization: Bearer <supabase access token>` + a store_staff row for the store.
// Memory mode (no Supabase): `Authorization: Bearer $STAFF_DEMO_TOKEN`; if that env var is unset, all staff calls are rejected.
import { createClient } from "@supabase/supabase-js";
import { getAdminDb } from "../db/admin";

export type StaffCheck = { ok: true; userId: string | null; label: string } | { ok: false; status: 401 | 403; error: string };

export async function requireStaff(request: Request, storeId: string | null): Promise<StaffCheck> {
  const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) return { ok: false, status: 401, error: "Sign in as store staff." };

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    const demo = process.env.STAFF_DEMO_TOKEN;
    return demo && token === demo ? { ok: true, userId: null, label: "demo-staff" } : { ok: false, status: 401, error: "Invalid staff token." };
  }

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
