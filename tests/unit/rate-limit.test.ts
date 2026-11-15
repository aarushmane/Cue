import { describe, expect, it } from "vitest";
import { clientKey, createLimiter } from "@/lib/api/rateLimit";

describe("createLimiter", () => {
  it("allows `limit` hits per window per key, then reports when to retry", () => {
    const l = createLimiter(2, 60_000);
    expect(l.hit("a", 0).ok).toBe(true);
    expect(l.hit("a", 1).ok).toBe(true);
    expect(l.hit("a", 30_000)).toEqual({ ok: false, retryAfter: 30 });
    expect(l.hit("b", 30_000).ok).toBe(true); // other clients unaffected
    expect(l.hit("a", 60_000).ok).toBe(true); // new window
  });

  it("stays bounded under a flood of distinct keys", () => {
    const l = createLimiter(1, 60_000);
    for (let i = 0; i < 10_050; i++) expect(l.hit(`k${i}`, 0).ok).toBe(true);
    expect(l.hit("k10049", 0).ok).toBe(false);
  });
});

describe("clientKey", () => {
  const req = (h: Record<string, string>) => new Request("http://x/api", { headers: h });
  it("prefers x-real-ip, then the first forwarded hop", () => {
    expect(clientKey(req({ "x-real-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" }))).toBe("1.1.1.1");
    expect(clientKey(req({ "x-forwarded-for": "3.3.3.3, 10.0.0.1" }))).toBe("3.3.3.3");
    expect(clientKey(req({}))).toBe("local");
  });
});
