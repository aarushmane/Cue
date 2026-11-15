"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RoutePlan, SceneItem, Vec3 } from "@/lib/wayfinding/types";

export type WayfindingStart = { sweep_id?: string; position?: Vec3 };
export type WayfindingContext = { start: WayfindingStart; waypoints?: { id: string; position: Vec3; floor_id: string | null; neighbors: string[] }[] };

export type WayfindingState =
  | { status: "idle" }
  | { status: "loading"; query: string }
  | { status: "ready"; query: string; reply: string | null; item: SceneItem | null; plan: RoutePlan | null }
  | { status: "choose"; query: string; options: SceneItem[] }
  | { status: "error"; query: string; message: string };

async function post(path: string, body: unknown, signal: AbortSignal) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  return { response, data: await response.json().catch(() => ({})) as Record<string, unknown> };
}

/**
 * Ask for an item and get a route. The deterministic route endpoint answers first (product catalogue, then a photo
 * search): it is instant for anything catalogued and never gives up on a whim. Only when it finds nothing does the
 * wayfinding agent get a turn, for wording the matcher doesn't understand.
 */
export function useWayfinding(modelId: string, context: () => WayfindingContext) {
  const [state, setState] = useState<WayfindingState>({ status: "idle" });
  const inflight = useRef<AbortController | null>(null);
  const rerouting = useRef<AbortController | null>(null);
  const latest = useRef(state);
  useEffect(() => { latest.current = state; }, [state]);

  const run = useCallback(async (query: string, body: Record<string, unknown>, agent: boolean) => {
    inflight.current?.abort();
    const abort = new AbortController();
    inflight.current = abort;
    setState({ status: "loading", query });
    try {
      const payload = { model_id: modelId, ...context(), ...body };
      let result = await post("/api/wayfinding/route", payload, abort.signal);
      if (agent && !abort.signal.aborted && result.data.status === "ITEM_NOT_FOUND") {
        const second = await post("/api/wayfinding/agent", payload, abort.signal);
        // Keep the agent's answer only if it worked (no AI, out of quota or a failure leave the first answer).
        if (second.response.ok) result = second;
      }
      const { response, data } = result;
      if (abort.signal.aborted) return;
      if (data.status === "AMBIGUOUS") return setState({ status: "choose", query, options: data.options as SceneItem[] });
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
  const reroute = useCallback(async (start: WayfindingStart) => {
    const current = latest.current;
    if (current.status !== "ready" || !current.item) return;
    const item = current.item;
    rerouting.current?.abort();
    const abort = new AbortController();
    rerouting.current = abort;
    try {
      const { response, data } = await post("/api/wayfinding/route", { model_id: modelId, ...context(), start, item_id: item.id, items: [item] }, abort.signal);
      const next = data.plan as RoutePlan | undefined;
      // Only take a usable route; if re-planning from here fails, keep showing the last one.
      if (abort.signal.aborted || !response.ok || !next || (next.status !== "OK" && next.status !== "ALREADY_THERE")) return;
      setState((prev) => (prev.status === "ready" && prev.item?.id === item.id ? { ...prev, plan: next } : prev));
    } catch {
      // Keep the previous route; the next move tries again.
    }
  }, [modelId, context]);

  return {
    state,
    reroute,
    find: (query: string) => run(query, { query }, true),
    choose: (item: SceneItem) => run(item.name, { item_id: item.id }, false),
    clear: () => { inflight.current?.abort(); rerouting.current?.abort(); setState({ status: "idle" }); },
  };
}
