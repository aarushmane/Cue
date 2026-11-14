import { afterEach, describe, expect, it, vi } from "vitest";
import { isGuiding, nearestRate, needsPosition, postTurn, prefsPatch, toNavPrefs } from "@/components/shopper/guide";

describe("shopper agent client helpers", () => {
  it("maps settings to agent prefs", () => {
    expect(toNavPrefs({ detail: "detailed", rate: 1.3 })).toEqual({ verbosity: "detailed", speech_rate: 1.3 });
  });

  it("snaps agent speech rates to the settings options", () => {
    expect(nearestRate(0.5)).toBe(0.8);
    expect(nearestRate(1.1)).toBe(1);
    expect(nearestRate(2)).toBe(1.3);
  });

  it("returns a settings patch only when the agent changed prefs", () => {
    const sent = { verbosity: "concise" as const, speech_rate: 1 };
    expect(prefsPatch(sent, sent)).toBeNull();
    expect(prefsPatch(sent, undefined)).toBeNull();
    expect(prefsPatch(sent, { verbosity: "detailed", speech_rate: 1 })).toEqual({ detail: "detailed" });
    expect(prefsPatch(sent, { verbosity: "concise", speech_rate: 0.7 })).toEqual({ rate: 0.8 });
  });

  it("asks for a position only when directions need one", () => {
    expect(needsPosition({ store_id: "s", state: "LOCATING" })).toBe(true);
    expect(needsPosition({ store_id: "s", state: "DESTINATION_SELECTED" })).toBe(true);
    expect(needsPosition({ store_id: "s", state: "DESTINATION_SELECTED", position_confidence: "LIKELY" })).toBe(false);
    expect(needsPosition({ store_id: "s", state: "SEARCHING" })).toBe(false);
    expect(isGuiding("GUIDING")).toBe(true);
    expect(isGuiding("ARRIVED")).toBe(false);
  });
});

describe("postTurn", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (status: number, body: unknown) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it("reports offline on 503", async () => {
    stub(503, { error: "AGENT_UNAVAILABLE", say: "offline" });
    expect(await postTurn({ store_id: "s" }, [], { utterance: "eggs" })).toEqual({ ok: false, offline: true, say: "offline" });
  });

  it("treats 502 as a one-off failure", async () => {
    stub(502, { error: "AGENT_ERROR", say: "try again" });
    expect(await postTurn({ store_id: "s" }, [], { utterance: "eggs" })).toEqual({ ok: false, offline: false, say: "try again" });
  });

  it("returns the reply on success", async () => {
    const reply = { say: "Which one?", agent_text: "Which one?", route_text: [], choices: ["A", "B"], ui_state: "SEARCHING", nav: { store_id: "s" }, history: [1] };
    stub(200, reply);
    expect(await postTurn({ store_id: "s" }, [], { utterance: "milk" })).toEqual({ ok: true, reply });
  });

  it("handles a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));
    const r = await postTurn({ store_id: "s" }, [], { utterance: "milk" });
    expect(r.ok).toBe(false);
  });
});
