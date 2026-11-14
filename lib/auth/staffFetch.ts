// fetch() for the manager app's calls to staff API routes. Adds `Authorization: Bearer <access token>`, which is
// what lib/auth/requireStaff.ts verifies (signature + expiry via Supabase Auth, then a store_staff row).
// Client-only.
import { getBrowserSupabase } from "./browserClient";

const signedOut = () =>
  Response.json({ code: "SIGNED_OUT", error: "Sign in as store staff." }, { status: 401 });

/** True when the request goes to this app's own origin. The token is never attached to any other host. */
function sameOrigin(input: RequestInfo | URL): boolean {
  const raw = input instanceof Request ? input.url : String(input);
  return new URL(raw, window.location.href).origin === window.location.origin;
}

/** A request can be sent a second time only if its body isn't a one-shot stream. */
function replayable(input: RequestInfo | URL, init: RequestInit): boolean {
  if (input instanceof Request && input.body) return false;
  return !(init.body instanceof ReadableStream);
}

/**
 * Like fetch(), for staff API routes on this app's own origin.
 * - Memory mode (no Supabase env): a plain fetch. There is no staff sign-in in memory mode.
 * - Supabase mode: attaches the current access token. getSession() refreshes it first when it has expired or
 *   expires within 90 seconds. If the server still answers 401 (for example the token was revoked), refreshes once
 *   and retries. With no session at all it returns a 401 without calling the server.
 */
export async function staffFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const supabase = getBrowserSupabase();
  if (!supabase) return fetch(input, init);
  if (!sameOrigin(input)) throw new TypeError("staffFetch only sends the staff token to this app's own API routes.");

  const send = (token: string) => {
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };

  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return signedOut();

  const res = await send(token);
  if (res.status !== 401 || !replayable(input, init)) return res;

  const { data: refreshed } = await supabase.auth.refreshSession();
  const fresh = refreshed.session?.access_token;
  return fresh && fresh !== token ? send(fresh) : res;
}
