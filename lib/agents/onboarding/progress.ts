// Live progress for an onboarding run, shared by the server (route handler) and the staff screen. Pure: no
// server-only imports, so it is safe in the client bundle and unit tested.
//
// Wire format: Server-Sent Events, one JSON event per `data:` line, blank line between events. Lines starting with
// ":" are keep-alive comments.
import type { OnboardingResult } from "./agent";

export type Todo = { content: string; status: "pending" | "in_progress" | "completed" };

export type OnboardEvent =
  | { type: "todos"; todos: Todo[] }
  | { type: "tool"; name: string }
  | { type: "result"; result: OnboardingResult }
  | { type: "error"; error: string };

export const asTodos = (t: unknown): Todo[] =>
  Array.isArray(t)
    ? t
        .filter((x): x is Todo => !!x && typeof (x as Todo).content === "string")
        .map((x) => ({ content: x.content, status: x.status === "completed" || x.status === "in_progress" ? x.status : "pending" }))
    : [];

// ───────────────────────────── Server: LangGraph "updates" → events ─────────────────────────────

/** The parts of the agent state the result is built from. Same shape as `agent.invoke()`'s return value. */
export interface AccumulatedState {
  messages: unknown[];
  todos: unknown[];
}

type ToolCallish = { tool_calls?: { name?: string }[] };

/**
 * Folds `agent.stream(..., { streamMode: "updates" })` chunks into the state `invoke()` would have returned and
 * reports what is new. A chunk is `{ [node]: update }`; a node returning several Commands (e.g. parallel tool
 * calls) yields an array of updates. The model node's AI message carries the tool calls about to run; the
 * write_todos tool's update carries `todos`.
 */
export function createUpdatesAccumulator() {
  const messages: unknown[] = [];
  let todos: unknown[] = [];
  let lastTodos = "";
  return {
    push(chunk: unknown): OnboardEvent[] {
      const out: OnboardEvent[] = [];
      if (!chunk || typeof chunk !== "object") return out;
      for (const update of Object.values(chunk as Record<string, unknown>)) {
        for (const u of Array.isArray(update) ? update : [update]) {
          if (!u || typeof u !== "object") continue;
          const m = (u as { messages?: unknown }).messages;
          const emitTodos = (t: unknown[]) => {
            const clean = asTodos(t);
            const key = JSON.stringify(clean);
            if (key === lastTodos) return;
            lastTodos = key;
            out.push({ type: "todos", todos: clean });
          };
          for (const msg of m == null ? [] : Array.isArray(m) ? m : [m]) {
            messages.push(msg);
            for (const tc of (msg as ToolCallish)?.tool_calls ?? []) {
              if (!tc?.name) continue;
              out.push({ type: "tool", name: tc.name });
              // Same fallback as extractPlan: show the plan from the call itself, in case the tool update never lands.
              const args = (tc as { args?: { todos?: unknown } }).args;
              if (tc.name === "write_todos" && Array.isArray(args?.todos)) emitTodos(args.todos);
            }
          }
          const t = (u as { todos?: unknown }).todos;
          if (Array.isArray(t)) {
            todos = t; // only real state updates feed the result, so it matches invoke()
            emitTodos(t);
          }
        }
      }
      return out;
    },
    state: (): AccumulatedState => ({ messages: [...messages], todos }),
  };
}

export const encodeEvent = (e: OnboardEvent) => `data: ${JSON.stringify(e)}\n\n`;

// ───────────────────────────── Client: SSE text → events ─────────────────────────────

const TYPES = new Set(["todos", "tool", "result", "error"]);

function toEvent(data: string): OnboardEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(data);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || !TYPES.has((v as { type?: string }).type ?? "")) return null;
  const e = v as OnboardEvent;
  if (e.type === "todos") return { type: "todos", todos: asTodos(e.todos) };
  if (e.type === "tool") return typeof e.name === "string" ? e : null;
  if (e.type === "error") return { type: "error", error: typeof e.error === "string" ? e.error : "Onboarding failed." };
  return e.result && typeof e.result === "object" ? e : null;
}

/**
 * Incremental SSE parser (WHATWG event-stream rules, as far as this app needs them): accepts arbitrary chunk
 * boundaries, LF / CRLF / CR line endings, multi-line `data:`, and ignores comments and other fields. An event is
 * dispatched at a blank line; a partial event left when the stream ends is dropped. Malformed or unknown events
 * are skipped rather than thrown.
 */
export function createSSEParser() {
  let buf = "";
  let data: string[] = [];
  return {
    feed(chunk: string): OnboardEvent[] {
      buf += chunk;
      const out: OnboardEvent[] = [];
      for (;;) {
        const m = /\r\n|\r|\n/.exec(buf);
        // A trailing "\r" may be the first half of "\r\n": wait for the next chunk.
        if (!m || (m[0] === "\r" && m.index === buf.length - 1)) break;
        const line = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        if (line === "") {
          if (data.length) {
            const e = toEvent(data.join("\n"));
            if (e) out.push(e);
          }
          data = [];
        } else if (line.startsWith("data:")) {
          data.push(line.slice(line[5] === " " ? 6 : 5));
        } else if (line === "data") {
          data.push("");
        }
        // ":" comments, event:, id:, retry: are ignored.
      }
      return out;
    },
    /** Call when the stream ends: a final bare "\r" was held back in case "\n" followed; it is a line end after all. */
    end(): OnboardEvent[] {
      return buf.endsWith("\r") ? this.feed("\n") : [];
    },
  };
}

// ───────────────────────────── Client: open and read the stream ─────────────────────────────

export const ONBOARD_STREAM_URL = "/api/agent/onboard/stream";

export type StreamOutcome =
  | { kind: "result"; result: OnboardingResult }
  /** `code` is set for refusals before the run starts (e.g. "PASSCODE", "BUSY"). */
  | { kind: "error"; error: string; code?: string }
  /** The stream could not be opened (route missing, network, unexpected response): use the Server Function. */
  | { kind: "fallback"; reason: string };

/** Refusals that the Server Function would give too, so falling back would only repeat them. */
const REFUSALS = new Set(["BACKEND_NOT_CONNECTED", "AI_NOT_CONFIGURED", "INVALID", "BUSY", "PASSCODE", "PASSCODE_NOT_SET"]);

/**
 * POST the run and read its events. Progress events go to `onEvent`; the terminal event is returned. Falls back
 * only when nothing has started: once the run is streaming, a dropped connection is an error, not a retry, so the
 * agent never runs twice (and never queues its suggestions twice). Aborting `signal` rejects with an AbortError.
 */
export async function streamOnboarding(
  body: { costar_property_id: string; store_id?: string; passcode?: string },
  io: { onEvent: (e: OnboardEvent) => void; signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<StreamOutcome> {
  let res: Response;
  try {
    res = await (io.fetchImpl ?? fetch)(ONBOARD_STREAM_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: io.signal,
    });
  } catch (err) {
    if (io.signal?.aborted) throw err;
    return { kind: "fallback", reason: err instanceof Error ? err.message : String(err) };
  }
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { code?: string; error?: string } | null;
    if (j?.code && REFUSALS.has(j.code) && j.error) return { kind: "error", error: j.error, code: j.code };
    return { kind: "fallback", reason: `HTTP ${res.status}` };
  }
  if (!res.body || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) return { kind: "fallback", reason: "not an event stream" };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSSEParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      const events = done ? [...parser.feed(decoder.decode()), ...parser.end()] : parser.feed(decoder.decode(value, { stream: true }));
      for (const e of events) {
        if (e.type === "result") return { kind: "result", result: e.result };
        if (e.type === "error") return { kind: "error", error: e.error };
        io.onEvent(e);
      }
      if (done) break;
    }
  } catch (err) {
    if (io.signal?.aborted) throw err;
  } finally {
    reader.cancel().catch(() => {});
  }
  return { kind: "error", error: "The connection to the onboarding agent was lost before it finished, so the run was stopped. Run it again." };
}

// ───────────────────────────── Client: screen-reader announcements ─────────────────────────────

/**
 * One polite announcement for a plan update, or null when nothing a listener needs changed. Announces the plan
 * appearing, then only steps that started or finished (several in one update are combined), never pending steps.
 */
export function todoAnnouncement(prev: Todo[], next: Todo[]): string | null {
  if (!next.length) return null;
  if (!prev.length) {
    const now = next.find((t) => t.status === "in_progress");
    return `Plan ready: ${next.length} step${next.length === 1 ? "" : "s"}.${now ? ` Started: ${now.content}.` : ""}`;
  }
  const done: string[] = [];
  const started: string[] = [];
  next.forEach((t, i) => {
    // Same step = same text; if the agent reworded it, the step in the same position.
    const was = (prev.find((p) => p.content === t.content) ?? prev[i])?.status ?? "pending";
    if (t.status === was) return;
    if (t.status === "completed") done.push(t.content);
    else if (t.status === "in_progress") started.push(t.content);
  });
  const parts = [done.length && `Done: ${done.join("; ")}.`, started.length && `Started: ${started.join("; ")}.`].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

/** Plain-language label for the "Now:" line. */
export function toolLabel(name: string): string {
  return (
    {
      write_todos: "Updating the plan",
      lookup_property: "Looking up the property in CoStar",
      fetch_twin: "Loading the Matterport digital twin",
      inspect_aerial: "Reading the aerial photo",
      build_draft_graph: "Building the walkable graph",
      propose_landmarks: "Choosing landmark scan points",
      task: "Recognizing shelf products (subagent)",
      recognize_shelf_image: "Recognizing shelf products",
      save_draft: "Saving the draft for staff review",
    } as Record<string, string>
  )[name] ?? name.replace(/_/g, " ");
}
