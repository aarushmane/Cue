"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RoutePlan, SceneItem, Vec3 } from "@/lib/wayfinding/types";
import type { VoiceEvent, VoiceResult } from "@/lib/voice/types";

export type WayfindingStart = { sweep_id?: string; position?: Vec3 };
export type WayfindingContext = { start: WayfindingStart; waypoints?: { id: string; position: Vec3; floor_id: string | null; neighbors: string[] }[] };

export type WayfindingState =
  | { status: "idle" }
  | { status: "loading"; query: string; label?: string }
  | { status: "ready"; query: string; reply: string | null; item: SceneItem | null; plan: RoutePlan | null }
  | { status: "choose"; query: string; options: SceneItem[] }
  | { status: "error"; query: string; message: string };

async function post(path: string, body: unknown, signal: AbortSignal) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  return { response, data: await response.json().catch(() => ({})) as Record<string, unknown> };
}

type StreamEvent = VoiceEvent | { type: "result"; data: VoiceResult } | { type: "error"; error: string };

/** Read the voice route's NDJSON stream, calling `onEvent` per line. */
async function stream(body: unknown, signal: AbortSignal, onEvent: (event: StreamEvent) => void) {
  const response = await fetch("/api/wayfinding/voice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error(String(data.error ?? "Could not search the scene."));
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (line: string) => {
    if (!line.trim()) return;
    try { onEvent(JSON.parse(line) as StreamEvent); } catch { /* skip malformed line */ }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    lines.forEach(flush);
  }
  flush(buffer + decoder.decode());
}

/**
 * Search the saved catalog and plan. A catalog miss on a typed query falls back to the AI search (photos + agent),
 * but its movement actions are ignored: a typed search never moves the visitor.
 */
export function useWayfinding(modelId: string, context: () => WayfindingContext) {
  const [state, setState] = useState<WayfindingState>({ status: "idle" });
  const inflight = useRef<AbortController | null>(null);
  const rerouting = useRef<AbortController | null>(null);
  const queued = useRef<WayfindingStart | null>(null);
  const latest = useRef(state);
  useEffect(() => { latest.current = state; }, [state]);
  useEffect(() => () => { inflight.current?.abort(); rerouting.current?.abort(); }, []);
  const cancel = useCallback(() => {
    inflight.current?.abort(); rerouting.current?.abort(); queued.current = null;
    setState((previous) => previous.status === "loading" ? { status: "idle" } : previous);
  }, []);
  const adopt = useCallback((query: string, reply: string, item: SceneItem | null, plan: RoutePlan) => {
    if ("item" in plan) {
      if (item && item.id !== plan.item.id) return;
      item = plan.item;
    }
    inflight.current?.abort(); rerouting.current?.abort(); queued.current = null;
    setState({ status: "ready", query, reply, item, plan });
  }, []);

  const run = useCallback(async (query: string, body: Record<string, unknown>) => {
    inflight.current?.abort();
    const abort = new AbortController();
    inflight.current = abort;
    setState({ status: "loading", query });
    try {
      const payload = { model_id: modelId, ...context(), ...body };
      const result = await post("/api/wayfinding/route", payload, abort.signal);
      const { response, data } = result;
      if (abort.signal.aborted) return;
      if (data.status === "AMBIGUOUS") return setState({ status: "choose", query, options: data.options as SceneItem[] });
      if (response.status === 404 && data.status === "ITEM_NOT_FOUND" && typeof body.query === "string") {
        let settled = false;
        await stream(payload, abort.signal, (event) => {
          if (abort.signal.aborted) return;
          if (event.type === "progress") {
            if (!settled) setState({ status: "loading", query, label: event.label });
          } else if (event.type === "route") {
            settled = true;
            setState({ status: "ready", query, reply: null, item: event.item ?? ("item" in event.plan ? event.plan.item : null), plan: event.plan });
          } else if (event.type === "result") {
            settled = true;
            const { reply, item, plan } = event.data;
            setState({ status: "ready", query, reply: reply || null, item: item ?? null, plan: plan ?? null });
          } else if (event.type === "error") {
            settled = true;
            setState({ status: "error", query, message: event.error || "Could not search the scene." });
          }
          // "action" events are ignored: typed search never moves the visitor.
        });
        if (!settled && !abort.signal.aborted) setState({ status: "error", query, message: "Could not search the scene." });
        return;
      }
      if (!response.ok && !data.plan) {
        return setState({ status: "error", query, message: String(data.reason ?? data.error ?? "Could not plan a route.") });
      }
      setState({
        status: "ready", query,
        reply: typeof data.reply === "string" && data.reply ? data.reply : null,
        item: (data.item as SceneItem) ?? null,
        plan: (data.plan as RoutePlan) ?? null,
      });
    } catch (error) {
      if (!abort.signal.aborted) setState({ status: "error", query, message: error instanceof Error ? error.message : "Could not plan a route." });
    }
  }, [modelId, context]);

  /**
   * The visitor moved: re-plan to the same item from the new start, without the loading state (the old route stays
   * on screen until the new one arrives). Sends the item itself, so photo-found items work too.
   */
  // One re-plan in flight at a time. Moving again meanwhile just records the latest position, which is sent as soon
  // as the current answer is in. (Cancelling the in-flight request instead starved slow devices: each new position
  // cancelled the previous answer before it could be shown.)
  const busy = useRef(false);
  const reroute = useCallback(async function next(start: WayfindingStart): Promise<void> {
    if (busy.current) { queued.current = start; return; }
    const current = latest.current;
    if (current.status !== "ready" || !current.item) return;
    const item = current.item;
    busy.current = true;
    const abort = new AbortController();
    rerouting.current = abort; // only cleared routes cancel it
    try {
      const { response, data } = await post("/api/wayfinding/route", { model_id: modelId, ...context(), start, item_id: item.id, items: [item] }, abort.signal);
      const plan = data.plan as RoutePlan | undefined;
      // Only take a usable route; if re-planning from here fails, keep showing the last one.
      if (!abort.signal.aborted && response.ok && plan && (plan.status === "OK" || plan.status === "ALREADY_THERE") && plan.item.id === item.id) {
        setState((prev) => (prev.status === "ready" && prev.item?.id === item.id ? { ...prev, plan } : prev));
      }
    } catch {
      // Keep the previous route; the next move tries again.
    } finally {
      busy.current = false;
      const waiting = queued.current;
      queued.current = null;
      if (waiting && !abort.signal.aborted) void next(waiting);
    }
  }, [modelId, context]);

  return {
    state,
    cancel,
    adopt,
    reroute,
    find: (query: string) => run(query, { query }),
    choose: (item: SceneItem) => run(item.name, { item_id: item.id, items: [item] }),
    clear: () => { inflight.current?.abort(); rerouting.current?.abort(); queued.current = null; setState({ status: "idle" }); },
  };
}
