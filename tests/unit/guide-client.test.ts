import { afterEach, describe, expect, it, vi } from "vitest";
import { carryPosition, isGuiding, MAX_SEND_HISTORY, nearestRate, needsPosition, postTurn, prefsPatch, toNavPrefs, trimForSend } from "@/components/shopper/guide";

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

describe("carryPosition", () => {
  it("keeps a known position as LIKELY", () => {
    expect(carryPosition({ store_id: "s", current_node_id: "N04", position_confidence: "CONFIRMED" })).toEqual({ current_node_id: "N04", position_confidence: "LIKELY" });
    expect(carryPosition({ store_id: "s", current_node_id: "N04", position_confidence: "LIKELY" })).toEqual({ current_node_id: "N04", position_confidence: "LIKELY" });
  });
  it("drops an unknown position", () => {
    expect(carryPosition({ store_id: "s", current_node_id: "N04", position_confidence: "UNKNOWN" })).toEqual({});
    expect(carryPosition({ store_id: "s", position_confidence: "CONFIRMED" })).toEqual({});
  });
});

describe("trimForSend", () => {
  const user = (t: string) => ({ role: "user", content: t });
  const toolUse = { role: "assistant", content: [{ type: "tool_use", id: "x", name: "search_products", input: {} }] };
  const toolResult = { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "{}" }] };

  it("leaves short histories alone", () => {
    const h = [user("a"), toolUse, toolResult];
    expect(trimForSend(h)).toBe(h);
  });

  it("cuts at a plain user turn, never between a tool call and its result (Anthropic shape)", () => {
    const turn = (i: number) => [user(`q${i}`), toolUse, toolResult, { role: "assistant", content: `a${i}` }];
    const h = Array.from({ length: 30 }, (_, i) => turn(i)).flat(); // 120 entries
    const out = trimForSend(h);
    expect(out.length).toBeLessThanOrEqual(MAX_SEND_HISTORY);
    expect(out[0]).toEqual(expect.objectContaining({ role: "user", content: expect.any(String) }));
    expect(out.at(-1)).toBe(h.at(-1));
  });

  it("recognizes Gemini plain user turns and skips function responses", () => {
    const gUser = (t: string) => ({ role: "user", parts: [{ text: t }] });
    const gCall = { role: "model", parts: [{ functionCall: { name: "next_step", args: {} } }] };
    const gResp = { role: "user", parts: [{ functionResponse: { name: "next_step", response: {} } }] };
    const h = Array.from({ length: 25 }, (_, i) => [gUser(`q${i}`), gCall, gResp]).flat(); // 75 entries
    const out = trimForSend(h, 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out[0]).toEqual(expect.objectContaining({ parts: [{ text: expect.any(String) }] }));
  });

  it("starts fresh when there is no safe cut point", () => {
    expect(trimForSend(Array(70).fill(toolResult))).toEqual([]);
  });
});
