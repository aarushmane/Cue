"use client";
// Floor plan viewer: stage fitted (contain) to the plan's own aspect ratio, transformed translate(tx,ty) scale(z)
// from origin 0 0 with z ∈ [1,5]. One pointer pans (6px threshold), two pointers pinch-zoom around the midpoint,
// − / + (×1.4) / reset buttons. Overlays are structured data drawn over (never baked into) the background image.
// Keyboard alternative: the viewport is focusable; arrows pan, + / − zoom, 0 resets, Enter places with the active tool.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { KIND_TXT } from "@/lib/map/graph";
import { shelfOf } from "@/lib/review/format";
import type { FloorPlan } from "@/lib/types";

export const VIEW_H = 420;
type View = { z: number; tx: number; ty: number };

export interface ViewerProps {
  map: FloorPlan;
  isEdit: boolean;
  placing: boolean;
  view: View;
  setView: (v: View) => void;
  verifiedAt: (shelfId: string) => number;
  pendingAt: (shelfId: string) => number;
  highlightShelf: (key: string, id: string) => boolean;
  highlightNode: (id: string) => boolean;
  highlightLandmark: (id: string) => boolean;
  routeEdges: Set<string>;
  onShelf: (key: string, id: string) => void;
  onNode: (id: string) => void;
  onLandmark: (id: string) => void;
  onPlace: (x: number, y: number) => void;
}

const clampZ = (z: number) => Math.min(5, Math.max(1, z));
export const edgeKey = (a: string, b: string) => [a, b].sort().join("|");

export function FloorPlanViewer(p: ViewerProps) {
  const vpRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [cw, setCw] = useState(327);
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const g = useRef<{ view: View; pts: Map<number, { x: number; y: number }>; moved: boolean } | null>(null);
  const dragged = useRef(false);

  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setCw(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const m = p.map;
  const asp = m.aspect || 1.5;
  let fw = cw, fh = cw / asp;
  if (fh > VIEW_H) {
    fh = VIEW_H;
    fw = VIEW_H * asp;
  }
  const fl = (cw - fw) / 2, ft = (VIEW_H - fh) / 2;
  const V = p.view;

  const zoomAt = (px: number, py: number, z1: number) => {
    const z = clampZ(z1);
    const lx = (px - V.tx) / V.z, ly = (py - V.ty) / V.z;
    p.setView({ z, tx: px - lx * z, ty: py - ly * z });
  };
  const zoom = (f: number) => zoomAt(cw / 2 - fl, VIEW_H / 2 - ft, V.z * f);

  const onDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest?.("[data-ui]")) return;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    g.current = { view: { ...V }, pts: new Map(ptrs.current), moved: ptrs.current.size > 1 };
    if (ptrs.current.size === 1) dragged.current = false;
  };
  const onMove = (e: PointerEvent) => {
    if (!ptrs.current.has(e.pointerId) || !g.current) return;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const G = g.current, v = G.view;
    if (ptrs.current.size >= 2 && G.pts.size >= 2) {
      const vr = vpRef.current!.getBoundingClientRect();
      const [a, b] = [...ptrs.current.values()], [a0, b0] = [...G.pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), d0 = Math.hypot(a0.x - b0.x, a0.y - b0.y) || 1;
      const z = clampZ((v.z * d) / d0);
      const mx = (a.x + b.x) / 2 - vr.left - fl, my = (a.y + b.y) / 2 - vr.top - ft;
      const m0x = (a0.x + b0.x) / 2 - vr.left - fl, m0y = (a0.y + b0.y) / 2 - vr.top - ft;
      const lx = (m0x - v.tx) / v.z, ly = (m0y - v.ty) / v.z;
      dragged.current = true;
      p.setView({ z, tx: mx - lx * z, ty: my - ly * z });
      return;
    }
    const p0 = G.pts.get(e.pointerId);
    if (!p0) return;
    const dx = e.clientX - p0.x, dy = e.clientY - p0.y;
    if (!G.moved && Math.hypot(dx, dy) < 6) return;
    G.moved = true;
    dragged.current = true;
    p.setView({ ...v, tx: v.tx + dx, ty: v.ty + dy });
  };
  const onUp = (e: PointerEvent) => {
    if (!ptrs.current.delete(e.pointerId)) return;
    const G = g.current;
    const t = e.target as HTMLElement;
    if (G && !G.moved && !ptrs.current.size && e.type === "pointerup" && p.isEdit && p.placing && !t.closest?.("[data-mk],[data-ui]")) {
      const r = stageRef.current?.getBoundingClientRect();
      if (r) {
        const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
        if (x >= 0 && x <= 1 && y >= 0 && y <= 1) p.onPlace(x, y);
      }
    }
    g.current = ptrs.current.size ? { view: { ...V }, pts: new Map(ptrs.current), moved: true } : null;
    if (!ptrs.current.size) setTimeout(() => (dragged.current = false), 0);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.target !== vpRef.current) return;
    const step = 40;
    const k = e.key;
    if (k === "ArrowLeft") p.setView({ ...V, tx: V.tx + step });
    else if (k === "ArrowRight") p.setView({ ...V, tx: V.tx - step });
    else if (k === "ArrowUp") p.setView({ ...V, ty: V.ty + step });
    else if (k === "ArrowDown") p.setView({ ...V, ty: V.ty - step });
    else if (k === "+" || k === "=") zoom(1.4);
    else if (k === "-") zoom(1 / 1.4);
    else if (k === "0") p.setView({ z: 1, tx: 0, ty: 0 });
    else if (k === "Enter" && p.isEdit && p.placing) {
      // Place at the centre of what is currently visible.
      const x = (cw / 2 - fl - V.tx) / V.z / fw, y = (VIEW_H / 2 - ft - V.ty) / V.z / fh;
      if (x >= 0 && x <= 1 && y >= 0 && y <= 1) p.onPlace(x, y);
    } else return;
    e.preventDefault();
  };

  const tap = (fn: () => void) => () => {
    if (!dragged.current) fn();
  };

  const nById = Object.fromEntries(m.nodes.map((n) => [n.id, n]));
  const byAisle: Record<string, typeof m.shelves> = {};
  m.shelves.filter((r) => r.id && shelfOf(r.id)).forEach((r) => (byAisle[shelfOf(r.id)!.aisle] ||= []).push(r));

  return (
    <div
      ref={vpRef}
      tabIndex={0}
      role="application"
      aria-roledescription="floor plan"
      aria-label={`Floor plan, zoom ${Math.round(V.z * 100)}%. Arrow keys pan, plus and minus zoom, 0 resets.${p.isEdit && p.placing ? " Enter places at the centre of the view." : ""} The text list below the map has every shelf.`}
      onKeyDown={onKey}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onPointerLeave={onUp}
      className="relative flex-none touch-none overflow-hidden rounded-[30px] border-[1.5px] border-card bg-lavender"
      style={{ height: VIEW_H, cursor: p.isEdit && p.placing ? "crosshair" : "grab" }}
    >
      <div
        ref={stageRef}
        className="absolute origin-top-left"
        style={{ left: fl, top: ft, width: fw, height: fh, transform: `translate(${V.tx}px,${V.ty}px) scale(${V.z})` }}
      >
        {m.plan ? (
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-no-repeat" style={{ backgroundImage: `url(${m.plan.url})`, backgroundSize: "100% 100%" }} />
        ) : (
          <div aria-hidden="true" className="absolute inset-0 rounded-[10px] border-[3px] border-mapline bg-[#FBFAF7]" />
        )}
        <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true" className="pointer-events-none absolute inset-0 size-full overflow-visible">
          {m.edges.map(([a, b]) => {
            if (!nById[a] || !nById[b]) return null;
            const on = p.routeEdges.has(edgeKey(a, b));
            return (
              <line
                key={edgeKey(a, b)}
                x1={nById[a].x} y1={nById[a].y} x2={nById[b].x} y2={nById[b].y}
                stroke={on ? "#E8B84B" : "#9C90C2"} strokeWidth={on ? 7 : 3} strokeDasharray={on ? "none" : "1 5"}
                strokeLinecap="round" vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>
        {Object.entries(byAisle).map(([a, rs]) => (
          <span
            key={a}
            aria-hidden="true"
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-full text-[10px] font-extrabold text-indigo"
            style={{ left: `${(rs.reduce((t, r) => t + r.x + r.w / 2, 0) / rs.length) * 100}%`, top: `${Math.min(...rs.map((r) => r.y)) * 100 - 1}%` }}
          >
            A{a}
          </span>
        ))}
        {m.shelves.map((r) => {
          const reg = r.id ? shelfOf(r.id) : undefined;
          const nV = r.id ? p.verifiedAt(r.id) : 0;
          const nP = r.id ? p.pendingAt(r.id) : 0;
          const hi = p.highlightShelf(r.key, r.id);
          return (
            <button
              key={r.key}
              type="button"
              data-mk="1"
              tabIndex={-1}
              onClick={tap(() => p.onShelf(r.key, r.id))}
              aria-label={reg ? `Aisle ${reg.aisle}, Section ${reg.section}: ${nV} verified products${nP ? `, ${nP} pending observations` : ""}` : "Shelf region without an ID"}
              className="absolute flex items-center justify-center rounded-md p-0 text-[9px] leading-[1.1] font-extrabold"
              style={{
                left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%`,
                border: `2px ${r.id ? "solid" : "dashed"} ${hi ? "#252331" : "#44337A"}`,
                background: hi ? "#44337A" : nV ? "#DCD3EC" : "#F7F5F0", color: hi ? "#FFFFFF" : "#44337A",
              }}
            >
              {reg ? `${reg.aisle}·${reg.section}` : "?"}
              {nP ? (
                <span className="absolute -top-2 -right-2 flex h-4 min-w-4 items-center justify-center rounded-full border-[1.5px] border-dashed border-charcoal bg-gold px-[3px] text-[9px] text-charcoal">
                  {nP}
                </span>
              ) : null}
            </button>
          );
        })}
        {m.nodes.map((n) => {
          const big = n.kind === "entrance" || n.kind === "service";
          const size = p.isEdit ? (big ? 24 : 20) : big ? 14 : 10;
          const hi = p.highlightNode(n.id);
          return (
            <button
              key={n.id}
              type="button"
              data-mk="1"
              tabIndex={-1}
              disabled={!p.isEdit}
              onClick={tap(() => p.onNode(n.id))}
              aria-label={`${KIND_TXT[n.kind] || "Point"} ${n.id}`}
              className="absolute rounded-full p-0"
              style={{
                left: `${n.x * 100}%`, top: `${n.y * 100}%`, width: size, height: size, margin: `${-size / 2}px 0 0 ${-size / 2}px`,
                background: big ? "#E8B84B" : "#44337A", border: `${hi ? 4 : 2}px solid ${hi ? "#252331" : "#F7F5F0"}`,
                pointerEvents: p.isEdit ? "auto" : "none",
              }}
            />
          );
        })}
        {m.landmarks.map((l) => {
          const size = p.isEdit ? 18 : 12;
          return (
            <button
              key={l.id}
              type="button"
              data-mk="1"
              tabIndex={-1}
              disabled={!p.isEdit}
              onClick={tap(() => p.onLandmark(l.id))}
              aria-label={`Landmark ${l.id} ${l.label || ""}${l.verified ? ", verified" : ", not verified"}`}
              className="absolute rotate-45 rounded-[3px] p-0"
              style={{
                left: `${l.x * 100}%`, top: `${l.y * 100}%`, width: size, height: size, margin: `${-size - 4}px 0 0 4px`,
                background: l.verified ? "#252331" : "#F7F5F0", border: `2px solid ${p.highlightLandmark(l.id) ? "#E8B84B" : "#252331"}`,
                pointerEvents: p.isEdit ? "auto" : "none",
              }}
            />
          );
        })}
        {m.nodes
          .filter((n) => n.kind === "entrance" || n.kind === "service")
          .map((n) => (
            <span
              key={"lb" + n.id}
              aria-hidden="true"
              className="pointer-events-none absolute -translate-x-1/2 translate-y-[9px] text-[9px] font-extrabold whitespace-nowrap text-indigo"
              style={{ left: `${n.x * 100}%`, top: `${n.y * 100}%` }}
            >
              {n.kind === "entrance" ? "ENTRANCE" : "HELP"}
            </span>
          ))}
      </div>

      <span
        data-ui="1"
        className="absolute top-3 left-3 max-w-[70%] truncate rounded-full px-3 py-1 text-xs font-bold text-charcoal"
        style={{ background: m.plan ? "#DCD3EC" : "#F8EBC8" }}
      >
        {m.plan ? `Uploaded plan · ${m.plan.name}` : "Demo floor plan · no plan uploaded"}
      </span>
      <div data-ui="1" className="absolute right-2.5 bottom-2.5 flex gap-1.5">
        <button type="button" onClick={() => zoom(1 / 1.4)} aria-label="Zoom out" className="size-11 rounded-full border-2 border-control bg-ivory text-[22px] font-bold text-charcoal">
          −
        </button>
        <button type="button" onClick={() => zoom(1.4)} aria-label="Zoom in" className="size-11 rounded-full border-2 border-control bg-ivory text-[22px] font-bold text-charcoal">
          +
        </button>
        <button
          type="button"
          onClick={() => p.setView({ z: 1, tx: 0, ty: 0 })}
          aria-label="Reset zoom and position"
          className="h-11 rounded-full border-2 border-control bg-ivory px-3 text-[13px] font-bold text-charcoal"
        >
          {Math.round(V.z * 100)}%
        </button>
      </div>
    </div>
  );
}
