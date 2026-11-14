import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeNext } from "@/lib/auth/config";

const auth = { getSession: vi.fn(), refreshSession: vi.fn() };
let client: { auth: typeof auth } | null = { auth };
vi.mock("@/lib/auth/browserClient", () => ({ getBrowserSupabase: () => client }));
const { staffFetch } = await import("@/lib/auth/staffFetch");

const session = (token: string | null) => ({ data: { session: token ? { access_token: token } : null } });
const authHeader = (call: unknown[]) => new Headers((call[1] as RequestInit).headers).get("authorization");

describe("safeNext", () => {
  it.each([
    ["/business/review?id=OBS-1", "/business/review?id=OBS-1"],
    ["/business", "/business"],
    [null, "/business"],
    ["https://evil.example/business", "/business"],
    ["//evil.example/business", "/business"],
    ["/\t/evil.example/business", "/business"],
    ["/\\evil.example", "/business"],
    ["/shopper", "/business"],
    ["/businessx", "/business"],
    ["/business/sign-in", "/business"],
    ["/business/../api/maps", "/business"],
  ])("%j → %j", (input, want) => expect(safeNext(input)).toBe(want));
});

describe("staffFetch", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    client = { auth };
    vi.stubGlobal("window", { location: new URL("https://store.test/business/review") });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it("adds the bearer token and keeps the caller's headers", async () => {
    auth.getSession.mockResolvedValue(session("tok-1"));
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await staffFetch("/api/maps/m1/publish", { method: "POST", headers: { "content-type": "application/json" } });
    expect(authHeader(fetchMock.mock.calls[0])).toBe("Bearer tok-1");
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get("content-type")).toBe("application/json");
  });

  it("refreshes once and retries when the server answers 401", async () => {
    auth.getSession.mockResolvedValue(session("old"));
    auth.refreshSession.mockResolvedValue(session("new"));
    fetchMock.mockResolvedValueOnce(new Response("", { status: 401 })).mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const res = await staffFetch("/api/products/P01/location", { method: "PATCH", body: "{}" });
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls.map(authHeader)).toEqual(["Bearer old", "Bearer new"]);
  });

  it("returns 401 without calling the server when signed out", async () => {
    auth.getSession.mockResolvedValue(session(null));
    const res = await staffFetch("/api/maps/m1/publish");
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never sends the token to another origin", async () => {
    auth.getSession.mockResolvedValue(session("tok-1"));
    await expect(staffFetch("https://evil.example/api")).rejects.toThrow(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is a plain fetch in memory mode", async () => {
    client = null;
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await staffFetch("/api/maps/m1/publish", { method: "POST" });
    expect(fetchMock).toHaveBeenCalledWith("/api/maps/m1/publish", { method: "POST" });
  });
});
