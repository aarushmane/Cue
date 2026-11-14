"use client";

import { useEffect, useRef, useState } from "react";
import { DEMO_NODES } from "@/lib/seed/demo-store";
import type { RouteResult } from "@/lib/types";
import { STORE_ID, useShopper } from "./ShopperProvider";
import { sBtn } from "./ShopperShell";

type Plan = Extract<RouteResult, { status: "OK" | "ALREADY_THERE" }>;

/** No agent or AI key needed: position is explicitly confirmed and all directions come from /api/routes. */
export function OfflineDirections({ productId }: { productId: string }) {
  const { say } = useShopper();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const stepBox = useRef<HTMLParagraphElement>(null);
  const entrance = DEMO_NODES.find((n) => n.kind === "entrance");
  const step = plan?.steps[0];
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => { if (plan) stepBox.current?.focus(); }, [plan]);

  const route = async (nodeId: string) => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    // Remove the old direction immediately: on a failed refresh it must not still appear actionable.
    setPlan(null);
    try {
      const response = await fetch("/api/routes", {
        method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ store_id: STORE_ID, start_node_id: nodeId, product_id: productId }),
      });
      const body: RouteResult = await response.json();
      if (!response.ok || (body.status !== "OK" && body.status !== "ALREADY_THERE")) {
        throw new Error("reason" in body ? body.reason : "Directions are unavailable. Try again or ask staff for help.");
      }
      if (!body.steps?.length) throw new Error("No directions were returned. Ask staff for help.");
      if (controller.signal.aborted) return;
      setPlan(body);
      // Focus announces the step to screen readers; don't also put it in the live region.
      say(body.steps[0].text, undefined, { announce: false });
    } catch (e) {
      if (controller.signal.aborted) return;
      const text = e instanceof Error ? e.message : "Directions are unavailable. Ask staff for help.";
      setError(text);
      say(text);
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  return (
    <section aria-label="Directions without the assistant" className={`${sBtn.card} flex flex-col gap-[0.7em]`}>
      <h2 className="m-0 text-[1.2em] font-extrabold">Directions without the assistant</h2>
      {!plan && <p className="m-0">Go to the store entrance first, then confirm below to get directions. Ask staff if you cannot find it.</p>}
      {entrance && !plan && <button type="button" disabled={busy} onClick={() => void route(entrance.id)} className={sBtn.primary}>
        {busy ? "Getting directions…" : "I'm at the store entrance — get directions"}
      </button>}
      {step && <>
        <p ref={stepBox} tabIndex={-1} className="m-0 text-[1.4em] font-extrabold">{step.text}</p>
        <button type="button" onClick={() => say(step.text)} className={sBtn.secondary}>Repeat step</button>
        {plan?.status === "ALREADY_THERE" ? <h3 className="m-0 text-[1.2em]">You have arrived</h3> :
          <button type="button" disabled={busy} onClick={() => void route(step.toNodeId)} className={sBtn.primary}>I completed this step — Next</button>}
      </>}
      {error && <p className="m-0 text-(--s-err)">{error}</p>}
    </section>
  );
}
