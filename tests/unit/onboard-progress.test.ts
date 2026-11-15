import { describe, expect, it } from "vitest";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import {
  createSSEParser, createUpdatesAccumulator, encodeEvent, streamOnboarding, todoAnnouncement, type OnboardEvent, type Todo,
} from "@/lib/agents/onboarding/progress";
import { extractPlan } from "@/lib/agents/onboarding/view";
import type { OnboardingResult } from "@/lib/agents/onboarding/agent";

const todos: Todo[] = [
  { content: "Look up property", status: "completed" },
  { content: "Fetch twin", status: "in_progress" },
  { content: "Save draft", status: "pending" },
];
const result = { run_id: "r1", report: "done", todos } as unknown as OnboardingResult;
const events: OnboardEvent[] = [
  { type: "todos", todos },
  { type: "tool", name: "fetch_twin" },
  { type: "result", result },
];
const wire = events.map(encodeEvent).join("");

describe("SSE event parser", () => {
  it("round-trips encoded events", () => {
    expect(createSSEParser().feed(wire)).toEqual(events);
  });

  it("gives the same events however the text is split into chunks", () => {
    const text = ": started\n\n" + wire.replace(/\n/g, "\r\n") + ": ping\r\n\r\n";
    for (let i = 0; i <= text.length; i++) {
      const p = createSSEParser();
      expect([...p.feed(text.slice(0, i)), ...p.feed(text.slice(i))], `split at ${i}`).toEqual(events);
    }
    // One character at a time.
    const p = createSSEParser();
    expect([...text].flatMap((c) => p.feed(c))).toEqual(events);
  });

  it("accepts LF, CRLF and bare CR line endings", () => {
    const e = `data: ${JSON.stringify({ type: "tool", name: "save_draft" })}`;
    for (const nl of ["\n", "\r\n", "\r"]) {
      const p = createSSEParser();
      expect([...p.feed(e + nl + nl), ...p.end()], JSON.stringify(nl)).toEqual([{ type: "tool", name: "save_draft" }]);
    }
    // A trailing "\r" is held until the next chunk shows whether "\n" follows; end() settles it.
    const p = createSSEParser();
    expect(p.feed(e + "\r\r")).toEqual([]);
    expect(p.end()).toEqual([{ type: "tool", name: "save_draft" }]);
  });

  it("joins multi-line data, allows 'data:' without a space, and ignores comments and other fields", () => {
    const text = [": keep-alive", "event: progress", "id: 7", "retry: 1000", 'data:{"type":"tool",', 'data: "name":"task"}', "", ""].join("\n");
    expect(createSSEParser().feed(text)).toEqual([{ type: "tool", name: "task" }]);
  });

  it("skips malformed, unknown and incomplete events without throwing", () => {
    const text = [
      "data: {not json", "",
      'data: {"type":"mystery"}', "",
      'data: {"type":"tool"}', "", // tool without a name
      'data: {"type":"result"}', "", // result without a payload
      "data: 42", "",
      'data: {"type":"error","error":"Quota reached"}', "",
      'data: {"type":"tool","name":"lost"}', // no blank line: dropped when the stream ends
    ].join("\n");
    expect(createSSEParser().feed(text)).toEqual([{ type: "error", error: "Quota reached" }]);
  });

  it("sanitizes todos", () => {
    const text = encodeEvent({ type: "todos", todos: [{ content: "A", status: "weird" }, { nope: 1 }, { content: "B", status: "completed" }] as unknown as Todo[] });
    expect(createSSEParser().feed(text)).toEqual([{ type: "todos", todos: [{ content: "A", status: "pending" }, { content: "B", status: "completed" }] }]);
  });

  it("keeps a JSON string containing newlines on one data line", () => {
    const e: OnboardEvent = { type: "error", error: "line 1\nline 2\r\n\n" };
    expect(encodeEvent(e).split("\n").filter(Boolean)).toHaveLength(1);
    expect(createSSEParser().feed(encodeEvent(e))).toEqual([e]);
  });
});

describe("updates accumulator (agent.stream streamMode: 'updates')", () => {
  const plan = [{ content: "Look up property", status: "in_progress" }];
  const planDone = [{ content: "Look up property", status: "completed" }];
  const chunks = [
    { model_request: { messages: [new AIMessage({ content: "", tool_calls: [{ id: "1", name: "write_todos", args: { todos: plan } }] })] } },
    { tools: { todos: plan, messages: [new ToolMessage({ content: "ok", tool_call_id: "1" })] } },
    { "TodoListMiddleware.after_model": null },
    { model_request: { messages: [new AIMessage({ content: "", tool_calls: [{ id: "2", name: "lookup_property", args: {} }, { id: "3", name: "fetch_twin", args: {} }] })] } },
    // Parallel tool calls: one update per Command.
    { tools: [{ messages: [new ToolMessage({ content: "p", tool_call_id: "2" })] }, { messages: [new ToolMessage({ content: "t", tool_call_id: "3" })] }] },
    { model_request: { messages: [new AIMessage({ content: "", tool_calls: [{ id: "4", name: "write_todos", args: { todos: planDone } }] })] } },
    { tools: { todos: planDone, messages: [new ToolMessage({ content: "ok", tool_call_id: "4" })] } },
    { tools: { todos: planDone } }, // unchanged plan: no event
    { model_request: { messages: [new AIMessage("Draft saved. Staff must verify the entrance.")] } },
  ];

  it("emits tool and todos events in order, once per change", () => {
    const acc = createUpdatesAccumulator();
    expect(chunks.flatMap((c) => acc.push(c))).toEqual([
      { type: "tool", name: "write_todos" },
      { type: "todos", todos: plan },
      { type: "tool", name: "lookup_property" },
      { type: "tool", name: "fetch_twin" },
      { type: "tool", name: "write_todos" },
      { type: "todos", todos: planDone },
    ]);
  });

  it("builds the same state invoke() returns, so both paths produce the same result fields", () => {
    const acc = createUpdatesAccumulator();
    acc.push({ __start__: { messages: [new HumanMessage("Onboard CoStar property 1.")] } });
    chunks.forEach((c) => acc.push(c));
    const state = acc.state();
    expect(extractPlan(state)).toEqual({ toolCalls: ["write_todos", "lookup_property", "fetch_twin", "write_todos"], todos: planDone });
    expect((state.messages.at(-1) as AIMessage).content).toBe("Draft saved. Staff must verify the entrance.");
  });

  it("ignores junk chunks", () => {
    const acc = createUpdatesAccumulator();
    for (const c of [null, undefined, 3, "x", [], { a: 1 }, { a: [null, 2] }, { a: { messages: null } }]) expect(acc.push(c)).toEqual([]);
    expect(acc.state()).toEqual({ messages: [], todos: [] });
  });
});

describe("todoAnnouncement", () => {
  const t = (...s: Todo["status"][]): Todo[] => s.map((status, i) => ({ content: `Step ${i + 1}`, status }));

  it("announces the plan once when it appears", () => {
    expect(todoAnnouncement([], t("in_progress", "pending"))).toBe("Plan ready: 2 steps. Started: Step 1.");
    expect(todoAnnouncement([], t("pending"))).toBe("Plan ready: 1 step.");
    expect(todoAnnouncement([], [])).toBeNull();
  });

  it("announces only steps that started or finished, combined into one message", () => {
    expect(todoAnnouncement(t("in_progress", "pending"), t("completed", "in_progress"))).toBe("Done: Step 1. Started: Step 2.");
    expect(todoAnnouncement(t("in_progress", "pending", "pending"), t("completed", "completed", "pending"))).toBe("Done: Step 1; Step 2.");
  });

  it("stays quiet when nothing changed or a step only became pending", () => {
    expect(todoAnnouncement(t("completed", "in_progress"), t("completed", "in_progress"))).toBeNull();
    expect(todoAnnouncement(t("completed"), [...t("completed"), { content: "New step", status: "pending" }])).toBeNull();
  });

  it("matches steps by text when the agent reorders them", () => {
    const prev: Todo[] = [{ content: "A", status: "in_progress" }, { content: "B", status: "pending" }];
    expect(todoAnnouncement(prev, [{ content: "B", status: "pending" }, { content: "A", status: "completed" }])).toBe("Done: A.");
  });
});

describe("streamOnboarding (client)", () => {
  const sse = (chunks: string[], init: ResponseInit = {}) => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        chunks.forEach((s) => c.enqueue(enc.encode(s)));
        c.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" }, ...init });
  };
  const fetchOf = (r: Response | Error) => (async () => (r instanceof Error ? Promise.reject(r) : r)) as unknown as typeof fetch;

  it("passes progress events and returns the result", async () => {
    const got: OnboardEvent[] = [];
    const split = Math.floor(wire.length / 2);
    const out = await streamOnboarding({ costar_property_id: "p" }, { onEvent: (e) => got.push(e), fetchImpl: fetchOf(sse([wire.slice(0, split), wire.slice(split)])) });
    expect(got).toEqual(events.slice(0, 2));
    expect(out).toEqual({ kind: "result", result });
  });

  it("returns the server's error event", async () => {
    const out = await streamOnboarding({ costar_property_id: "p" }, { onEvent: () => {}, fetchImpl: fetchOf(sse([encodeEvent({ type: "error", error: "Quota" })])) });
    expect(out).toEqual({ kind: "error", error: "Quota" });
  });

  it("shows refusals the Server Function would repeat, and falls back otherwise", async () => {
    const refusal = Response.json({ ok: false, status: 503, code: "AI_NOT_CONFIGURED", error: "No AI provider" }, { status: 503 });
    expect(await streamOnboarding({ costar_property_id: "p" }, { onEvent: () => {}, fetchImpl: fetchOf(refusal) })).toEqual({ kind: "error", error: "No AI provider", code: "AI_NOT_CONFIGURED" });
    const busy = Response.json({ ok: false, status: 429, code: "BUSY", error: "Another run" }, { status: 429 });
    expect(await streamOnboarding({ costar_property_id: "p" }, { onEvent: () => {}, fetchImpl: fetchOf(busy) })).toEqual({ kind: "error", error: "Another run", code: "BUSY" });
    for (const r of [new Response("not found", { status: 404 }), new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }), new TypeError("Failed to fetch")]) {
      expect((await streamOnboarding({ costar_property_id: "p" }, { onEvent: () => {}, fetchImpl: fetchOf(r) })).kind).toBe("fallback");
    }
  });

  it("treats a stream that ends without a result as an error, not a fallback (never runs twice)", async () => {
    const out = await streamOnboarding({ costar_property_id: "p" }, { onEvent: () => {}, fetchImpl: fetchOf(sse([encodeEvent(events[0])])) });
    expect(out.kind).toBe("error");
  });

  it("rejects when aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const f = (async (_u: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return sse([]);
    }) as unknown as typeof fetch;
    await expect(streamOnboarding({ costar_property_id: "p" }, { onEvent: () => {}, signal: ac.signal, fetchImpl: f })).rejects.toThrow(/aborted/);
  });
});
