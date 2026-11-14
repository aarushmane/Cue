// A tiny stand-in for the parts of Supabase the staff sign-in uses, so the Supabase-mode e2e tests
// (playwright.auth.config.ts) run without a real project:
//   POST /auth/v1/token?grant_type=password | refresh_token   GET /auth/v1/user   POST /auth/v1/logout
//   HEAD|GET /rest/v1/store_staff?user_id=eq.<id>  (count of the user's staff rows)
//   GET /__stats (refresh count, for tests)   POST /__reset
// Tokens are opaque to the app except for their JWT shape; the stub remembers which token belongs to which user.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.STUB_PORT ?? 54399);
const USERS = {
  "staff@example.com": { id: "00000000-0000-4000-8000-000000000001", password: "correct-horse", staff: true, ttl: 3600 },
  // Short-lived access token: getSession() treats it as about to expire, so every page load refreshes it.
  "short@example.com": { id: "00000000-0000-4000-8000-000000000002", password: "correct-horse", staff: true, ttl: 30 },
  "visitor@example.com": { id: "00000000-0000-4000-8000-000000000003", password: "correct-horse", staff: false, ttl: 3600 },
};
let access = new Map(); // access token -> email
let refresh = new Map(); // refresh token -> email
let stats = { refreshes: 0, logouts: 0 };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function session(email) {
  const u = USERS[email];
  const now = Math.floor(Date.now() / 1000);
  const user = { id: u.id, aud: "authenticated", role: "authenticated", email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  const jwt = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: u.id, email, aud: "authenticated", role: "authenticated", exp: now + u.ttl, iat: now, session_id: randomUUID() })}.stub-signature`;
  const rt = randomUUID();
  access.set(jwt, email);
  refresh.set(rt, email);
  return { access_token: jwt, token_type: "bearer", expires_in: u.ttl, expires_at: now + u.ttl, refresh_token: rt, user };
}

const userOf = (req) => access.get(/^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "");

function send(res, req, status, body, headers = {}) {
  res.writeHead(status, {
    "access-control-allow-origin": req.headers.origin ?? "*",
    "access-control-allow-credentials": "true",
    "access-control-expose-headers": "content-range, x-supabase-api-version",
    "content-type": "application/json",
    ...headers,
  });
  res.end(body === undefined || req.method === "HEAD" ? undefined : JSON.stringify(body));
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === "OPTIONS") {
    return send(res, req, 204, undefined, {
      "access-control-allow-methods": "GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS",
      "access-control-allow-headers": req.headers["access-control-request-headers"] ?? "*",
    });
  }
  let body = {};
  if (req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
  }
  const p = url.pathname;

  if (p === "/__stats") return send(res, req, 200, stats);
  if (p === "/__reset") { access = new Map(); refresh = new Map(); stats = { refreshes: 0, logouts: 0 }; return send(res, req, 200, {}); }

  if (p === "/auth/v1/token" && url.searchParams.get("grant_type") === "password") {
    const u = USERS[body.email];
    if (!u || u.password !== body.password) {
      return send(res, req, 400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
    }
    return send(res, req, 200, session(body.email));
  }
  if (p === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
    const email = refresh.get(body.refresh_token);
    if (!email) return send(res, req, 400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" });
    // Rotation with Supabase's default 10 s reuse interval: the browser and the proxy may refresh with the same
    // token at the same moment, and both must succeed.
    setTimeout(() => refresh.delete(body.refresh_token), 10_000).unref();
    stats.refreshes++;
    return send(res, req, 200, session(email));
  }
  if (p === "/auth/v1/user") {
    const email = userOf(req);
    return email ? send(res, req, 200, session(email).user) : send(res, req, 401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
  }
  if (p === "/auth/v1/logout") {
    access.delete(/^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "");
    stats.logouts++;
    return send(res, req, 204);
  }
  if (p === "/rest/v1/store_staff") {
    const id = (url.searchParams.get("user_id") ?? "").replace(/^eq\./, "");
    const n = Object.values(USERS).some((u) => u.id === id && u.staff) ? 1 : 0;
    return send(res, req, 200, n ? [{ store_id: "demo-store", role: "staff" }] : [], { "content-range": n ? "0-0/1" : "*/0" });
  }
  return send(res, req, 404, { message: `stub: no route for ${req.method} ${p}` });
}).listen(PORT, () => console.log(`stub supabase on ${PORT}`));
