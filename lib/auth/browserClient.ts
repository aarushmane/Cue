// Browser-side Supabase client for staff auth. The session (access + refresh token) is kept in cookies by
// @supabase/ssr, so proxy.ts can see it on page requests and refresh it. Call only from client code.
import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AUTH_COOKIE_OPTIONS, supabasePublicEnv } from "./config";

let client: SupabaseClient | null | undefined;

/** The shared browser client, or null in memory mode (no Supabase env). */
export function getBrowserSupabase(): SupabaseClient | null {
  if (client !== undefined) return client;
  const env = supabasePublicEnv();
  client = env ? createBrowserClient(env.url, env.anonKey, { cookieOptions: AUTH_COOKIE_OPTIONS }) : null;
  return client;
}
