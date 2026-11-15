"use client";

import { useEffect, useRef } from "react";
import type { MpSdk } from "@matterport/sdk";
import { edgeIndicator, lookAhead, projectArrows, projectPolyline } from "@/lib/wayfinding/screen";
import type { RoutePlan } from "@/lib/wayfinding/types";
import { projectorFor, toApi, type Pose } from "./showcase";

type OkPlan = Extract<RoutePlan, { status: "OK" | "ALREADY_THERE" }>;

/**
 * Draws the planned route over the Showcase view: a path line on the floor, chevrons pointing the way, a pin on the
 * item, and an edge arrow toward the next stretch of route when it is off screen. Redraws on every camera move.
 */
export function RouteOverlay({ sdk, plan }: { sdk: MpSdk; plan: OkPlan }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current!;
    const ctx = el.getContext("2d")!;
    const css = getComputedStyle(el);
    const color = css.getPropertyValue("--route-color").trim() || "#fcd44a";
    const ink = css.getPropertyValue("--route-ink").trim() || "#ffffff";
    let pose: Pose | null = null;
    let frame = 0;

    const draw = () => {
      frame = 0;
      const dpr = Math.min(window.devicePixelRatio, 2);
      const w = el.clientWidth, h = el.clientHeight;
      if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) { el.width = Math.round(w * dpr); el.height = Math.round(h * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!pose) return;
      const size = { w, h };
      const project = projectorFor(sdk, pose, size);

      // Path on the floor.
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const run of projectPolyline(plan.polyline, project)) {
        ctx.beginPath();
        run.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = color;
        ctx.lineWidth = 6;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // Chevrons, nearest last so they draw on top.
      for (const a of projectArrows(plan.arrows, project, size).sort((x, y) => x.sizePx - y.sizePx)) {
        const s = Math.max(10, Math.min(a.sizePx, 36));
        ctx.save();
        ctx.translate(a.x, a.y);
        ctx.rotate(a.angleRad);
        ctx.beginPath();
        ctx.moveTo(-s * 0.2, -s * 0.35);
        ctx.lineTo(s * 0.2, 0);
        ctx.lineTo(-s * 0.2, s * 0.35);
        ctx.strokeStyle = ink;
        ctx.lineWidth = 7;
        ctx.stroke();
        ctx.strokeStyle = color;
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.restore();
      }

      // Item pin.
      const item = project(plan.item.position);
      if (item.z >= -1 && item.z <= 1) {
        ctx.beginPath();
        ctx.arc(item.x, item.y, 11, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = ink;
        ctx.stroke();
      }

      // Which way to turn when the next stretch is off screen.
      const visitor = toApi(sdk, pose.position);
      const target = plan.status === "ALREADY_THERE" ? plan.item.position : lookAhead(plan.polyline, visitor, 2);
      const edge = edgeIndicator(project(target), size);
      if (edge) {
        ctx.save();
        ctx.translate(edge.x, edge.y);
        ctx.rotate(edge.angleRad);
        ctx.beginPath();
        ctx.moveTo(22, 0);
        ctx.lineTo(-14, -18);
        ctx.lineTo(-6, 0);
        ctx.lineTo(-14, 18);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = ink;
        ctx.stroke();
        ctx.restore();
      }
    };

    const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };
    const sub = sdk.Camera.pose.subscribe((next) => { pose = next; schedule(); });
    const resize = new ResizeObserver(schedule);
    resize.observe(el);
    return () => { sub.cancel(); resize.disconnect(); cancelAnimationFrame(frame); };
  }, [sdk, plan]);

  return <canvas ref={canvas} className="pointer-events-none absolute inset-0 size-full" aria-hidden="true" />;
}
