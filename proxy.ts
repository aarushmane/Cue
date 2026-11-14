// Next 16 Proxy (formerly Middleware). Gates the manager app (/business/*) when Supabase is configured:
// - no session → redirect to /business/sign-in?next=<where they were going>
// - signed in and on the sign-in page → go to the manager app
// It also refreshes an expiring session and writes the new cookies, which Server Components can't do.
// This is an optimistic gate only (it trusts the cookie). Staff data is protected where it's read and written:
// every staff API route calls requireStaff() (token verified by Supabase Auth + store_staff row), and row-level
// security covers direct Supabase reads.
// Memory mode (no NEXT_PUBLIC_SUPABASE_URL) passes everything through, exactly as before.
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE_OPTIONS, safeNext, SIGN_IN_PATH, signInRequired, supabasePublicEnv } from "@/lib/auth/config";

export async function proxy(request: NextRequest) {
  if (!signInRequired()) return NextResponse.next();

  let response = NextResponse.next({ request });
  let signedIn = false;
  const env = supabasePublicEnv();
  if (env) {
    const supabase = createServerClient(env.url, env.anonKey, {
      cookieOptions: AUTH_COOKIE_OPTIONS,
      cookies: {
        getAll: () => request.cookies.getAll(),
        // A refresh rewrites the auth cookies: pass them to this request's handlers and back to the browser,
        // with the no-store headers @supabase/ssr supplies so a CDN never caches a response that sets a session.
        setAll: (cookiesToSet, headers) => {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
          Object.entries(headers ?? {}).forEach(([k, v]) => response.headers.set(k, v));
        },
      },
    });
    // Optimistic check, as Next's auth guide recommends for Proxy: read the session from the cookie, with no network
    // call unless the access token has expired (or is about to) and must be refreshed. Not getClaims(): on projects
    // still using the legacy shared JWT secret it calls Supabase Auth on every page load. A forged cookie gets only
    // the manager page's client code, which holds no data; every staff API call is verified by requireStaff().
    // Only the token is read: session.user from a cookie is unverified (and supabase-js warns when it's accessed).
    const { data } = await supabase.auth.getSession();
    signedIn = !!data.session?.access_token;
  }
  // URL set but anon key missing: nobody can sign in. Fail closed; the sign-in page explains the misconfiguration.

  const path = request.nextUrl.pathname;
  const onSignIn = path === SIGN_IN_PATH;
  if (!signedIn && !onSignIn) {
    const to = new URL(SIGN_IN_PATH, request.url);
    to.searchParams.set("next", path + request.nextUrl.search);
    return withCookies(NextResponse.redirect(to), response);
  }
  if (signedIn && onSignIn) {
    const to = new URL(safeNext(request.nextUrl.searchParams.get("next")), request.url);
    return withCookies(NextResponse.redirect(to), response);
  }
  return response;
}

/** Carry refreshed (or cleared) auth cookies over to a redirect, so a refresh isn't lost on the way. */
function withCookies(redirect: NextResponse, from: NextResponse): NextResponse {
  from.cookies.getAll().forEach((c) => redirect.cookies.set(c));
  const cc = from.headers.get("cache-control");
  if (cc) redirect.headers.set("cache-control", cc);
  return redirect;
}

export const config = {
  // `:path*` also matches /business itself.
  matcher: ["/business/:path*"],
};
