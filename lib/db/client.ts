import "server-only";
import { createClient } from "@supabase/supabase-js";

export function getDb(access: "read" | "write") {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = access === "write"
    ? process.env.SUPABASE_SERVICE_ROLE_KEY
    : process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase is not configured.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
