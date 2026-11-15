// Per-key fixed-window rate limiter, in process memory (issue #6, 4G). Enough for one server or a demo deploy; with
// several instances each one counts separately, so the effective limit is per instance. Server only.
const MAX_KEYS = 10_000;

export interface Limiter {
  /** Count one hit for `key`. ok=false (with seconds until the window resets) once the limit is reached. */
  hit(key: string, now?: number): { ok: true } | { ok: false; retryAfter: number };
}

export function createLimiter(limit: number, windowMs: number): Limiter {
  const hits = new Map<string, { n: number; reset: number }>();
  return {
    hit(key, now = Date.now()) {
      let e = hits.get(key);
      if (!e || now >= e.reset) {
        if (!e && hits.size >= MAX_KEYS) {
          for (const [k, v] of hits) if (now >= v.reset) hits.delete(k);
          // Still full of live windows (a flood of distinct keys): drop the oldest instead of growing without bound.
          if (hits.size >= MAX_KEYS) hits.delete(hits.keys().next().value!);
        }
        e = { n: 0, reset: now + windowMs };
        hits.set(key, e);
      }
      if (e.n >= limit) return { ok: false, retryAfter: Math.max(1, Math.ceil((e.reset - now) / 1000)) };
      e.n++;
      return { ok: true };
    },
  };
}

/**
 * Client address for rate limiting. On Vercel and most proxies the platform sets x-real-ip / the first
 * x-forwarded-for hop; elsewhere a client can spoof these headers, so this is abuse damping, not identity.
 */
export function clientKey(request: Request): string {
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const xff = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return xff || "local";
}
