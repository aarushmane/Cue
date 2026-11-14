import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireOnboardingLock, checkOnboardingRequest, passcodeMatches } from "@/lib/demo/onboard-guard";

afterEach(() => vi.unstubAllEnvs());

const memoryMode = () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", "test-key");
};

describe("acquireOnboardingLock", () => {
  it("allows one run at a time and frees the lock on release", () => {
    const release = acquireOnboardingLock();
    expect(release).toBeTypeOf("function");
    expect(acquireOnboardingLock()).toBeNull();
    release!();
    const again = acquireOnboardingLock();
    expect(again).toBeTypeOf("function");
    again!();
  });

  it("a second release of an old holder does not free a newer run's lock", () => {
    const first = acquireOnboardingLock()!;
    first();
    const second = acquireOnboardingLock()!;
    first(); // stale release
    expect(acquireOnboardingLock()).toBeNull();
    second();
  });

  it("treats a lock older than any possible run as stale", () => {
    const t0 = 1_000_000;
    const leaked = acquireOnboardingLock(t0)!;
    expect(acquireOnboardingLock(t0 + 60_000)).toBeNull();
    const next = acquireOnboardingLock(t0 + 7 * 60_000);
    expect(next).toBeTypeOf("function");
    leaked(); // no effect: the lock belongs to `next` now
    expect(acquireOnboardingLock(t0 + 7 * 60_000)).toBeNull();
    next!();
  });
});

describe("passcode", () => {
  it("compares exactly", () => {
    expect(passcodeMatches("open sesame", "open sesame")).toBe(true);
    expect(passcodeMatches("open sesam", "open sesame")).toBe(false);
    expect(passcodeMatches(undefined, "x")).toBe(false);
    expect(passcodeMatches(42, "42")).toBe(false);
  });

  it("is required when ONBOARD_PASSCODE is set", () => {
    memoryMode();
    vi.stubEnv("ONBOARD_PASSCODE", "s3cret");
    expect(checkOnboardingRequest("p1")).toMatchObject({ ok: false, status: 401, code: "PASSCODE" });
    expect(checkOnboardingRequest("p1", "demo-store", "nope")).toMatchObject({ ok: false, code: "PASSCODE", error: "That passcode is not right." });
    expect(checkOnboardingRequest("p1", "demo-store", "s3cret")).toEqual({ ok: true, propertyId: "p1", storeId: "demo-store" });
  });

  it("is optional in development and required in production", () => {
    memoryMode();
    vi.stubEnv("ONBOARD_PASSCODE", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(checkOnboardingRequest("p1")).toMatchObject({ ok: true });
    vi.stubEnv("NODE_ENV", "production");
    expect(checkOnboardingRequest("p1")).toMatchObject({ ok: false, status: 503, code: "PASSCODE_NOT_SET" });
  });

  it("Supabase mode refuses before the passcode is looked at", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    vi.stubEnv("ONBOARD_PASSCODE", "s3cret");
    expect(checkOnboardingRequest("p1")).toMatchObject({ code: "BACKEND_NOT_CONNECTED" });
  });
});
