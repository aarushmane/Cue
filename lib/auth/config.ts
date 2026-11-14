// Staff sign-in settings shared by proxy.ts (server), the browser Supabase client and the sign-in page.
// NEXT_PUBLIC_* values are inlined into client bundles at build time; proxy.ts reads them at request time.

export const SIGN_IN_PATH = "/business/sign-in";
export const MANAGER_HOME = "/business";

/** Sign-in is required whenever a Supabase project URL is configured. Memory mode (no URL) stays open. */
export const signInRequired = () => !!process.env.NEXT_PUBLIC_SUPABASE_URL;

/** The URL and anon key, or null when either is missing (the anon key is public by design; RLS protects data). */
export function supabasePublicEnv(): { url: string; anonKey: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && anonKey ? { url, anonKey } : null;
}

/**
 * Auth cookie options. Must be identical in proxy.ts and the browser client, or each side writes its own copy.
 * @supabase/ssr defaults: path "/", SameSite=Lax, not HttpOnly (the browser client must read the session).
 * Secure in production so the session never travels over plain HTTP (browsers treat localhost as secure).
 */
export const AUTH_COOKIE_OPTIONS = { secure: process.env.NODE_ENV === "production" } as const;

/**
 * Where to go after signing in. Only a path inside the manager app is accepted, so `?next=` can't be used to send
 * a freshly signed-in employee to another site (open redirect) or back to the sign-in page.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return MANAGER_HOME;
  let u: URL;
  try {
    u = new URL(next, "http://local.invalid");
  } catch {
    return MANAGER_HOME;
  }
  // The URL parser strips tabs and newlines, so "/\t/evil.example" becomes protocol-relative: re-check the origin.
  if (u.origin !== "http://local.invalid") return MANAGER_HOME;
  const inManager = u.pathname === MANAGER_HOME || u.pathname.startsWith(MANAGER_HOME + "/");
  if (!inManager || u.pathname === SIGN_IN_PATH) return MANAGER_HOME;
  return u.pathname + u.search + u.hash;
}
