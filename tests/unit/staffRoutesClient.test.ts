import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callJson } from "@/lib/api/client";
import { requireStaff } from "@/lib/auth/requireStaff";

describe("requireStaff in memory mode", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    vi.stubEnv("STAFF_DEMO_TOKEN", "demo-token");
  });
  afterEach(() => vi.unstubAllEnvs());

  const req = (headers: Record<string, string>) => new Request("http://store.test/api/maps/m/publish", { method: "POST", headers });

  it.each([
    ["the demo token", { authorization: "Bearer demo-token" }, true],
    ["a wrong token, even from the app's own page", { authorization: "Bearer nope", "sec-fetch-site": "same-origin" }, false],
    ["the manager app's own page (Sec-Fetch-Site)", { "sec-fetch-site": "same-origin" }, true],
    ["another site's page", { "sec-fetch-site": "cross-site", origin: "http://evil.example" }, false],
    ["a same-site but different-origin page", { "sec-fetch-site": "same-site" }, false],
    ["an older browser: matching Origin", { origin: "http://store.test", host: "store.test" }, true],
    ["an older browser: other Origin", { origin: "http://evil.example", host: "store.test" }, false],
    ["a script with no token and no browser headers", {}, false],
  ])("%s → %s", async (_label, headers, ok) => {
    const r = await requireStaff(req(headers as Record<string, string>), "demo-store");
    expect(r.ok).toBe(ok);
    if (!r.ok) expect(r.status).toBe(401);
  });
});

describe("callJson", () => {
  it("passes a 2xx body through with ok: true", async () => {
    const r = await callJson<{ version: number }>(Promise.resolve(Response.json({ version: 3 })));
    expect(r).toEqual({ ok: true, version: 3 });
  });

  it("keeps the contract's code, error and failing labels", async () => {
    const r = await callJson(Promise.resolve(Response.json({ code: "INVALID", error: "Nope.", failing: ["Shelf"] }, { status: 422 })));
    expect(r).toEqual({ ok: false, status: 422, code: "INVALID", error: "Nope.", failing: ["Shelf"] });
  });

  it("gives a readable error for a body without one (400 issues) and for no response at all", async () => {
    const bad = await callJson(Promise.resolve(Response.json({ code: "BAD_REQUEST", issues: [] }, { status: 400 })));
    expect(bad).toMatchObject({ ok: false, status: 400, code: "BAD_REQUEST", error: "The request was malformed. Nothing was changed." });
    const down = await callJson(Promise.reject(new TypeError("Failed to fetch")));
    expect(down).toMatchObject({ ok: false, status: 0, code: "NETWORK" });
  });
});
