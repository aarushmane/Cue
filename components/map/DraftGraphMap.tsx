"use client";
// Read-only drawing of an onboarding draft graph: scan points and walkable paths over the twin's floor plan.
// Coordinates are normalized 0..1 (MapNode convention); the plan image may extend past the graph's bounds.
import type { GraphView, PlanDebug } from "@/lib/agents/onboarding/view";

const W = 1000;
const DEV = process.env.NODE_ENV !== "production";

export function DraftGraphMap({ graph, showPlan = true }: { graph: GraphView; showPlan?: boolean }) {
  const aspect = graph.width_m > 0 && graph.height_m > 0 ? graph.width_m / graph.height_m : 1.5;
  const H = Math.round(W / Math.min(4, Math.max(0.25, aspect)));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const r = Math.max(5, Math.min(12, 260 / Math.sqrt(graph.nodes.length + 1)));
  const entrance = graph.nodes.filter((n) => n.kind === "entrance").length;
  const landmarks = graph.nodes.filter((n) => n.landmark).length;
  const label =
    `Draft map: ${graph.nodes.length} scan points and ${graph.edges.length} walkable paths` +
    `${entrance ? ", entrance marked" : ""}${landmarks ? `, ${landmarks} landmark points` : ""}.`;

  return (
    <div className="overflow-hidden rounded-[22px] border-[1.5px] border-card bg-white">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="block h-auto w-full">
        {showPlan && graph.plan && (
          <image
            href={graph.plan.url}
            x={graph.plan.x * W}
            y={graph.plan.y * H}
            width={graph.plan.w * W}
            height={graph.plan.h * H}
            preserveAspectRatio="none"
            opacity={0.85}
          />
        )}
        {DEV && graph.debug && <PlanDebugLayer debug={graph.debug} plan={graph.plan} H={H} />}
        <g stroke="#44337A" strokeWidth={3} strokeLinecap="round" opacity={0.75}>
          {graph.edges.map(([a, b]) => {
            const p = byId.get(a);
            const q = byId.get(b);
            return p && q ? <line key={`${a}|${b}`} x1={p.x * W} y1={p.y * H} x2={q.x * W} y2={q.y * H} /> : null;
          })}
        </g>
        <g>
          {graph.nodes.map((n) => (
            <circle
              key={n.id}
              cx={n.x * W}
              cy={n.y * H}
              r={n.kind === "entrance" ? r * 1.6 : r}
              fill={n.kind === "entrance" ? "#E8B84B" : n.landmark ? "#FFFFFF" : "#44337A"}
              stroke={n.landmark || n.kind === "entrance" ? "#252331" : "none"}
              strokeWidth={n.landmark || n.kind === "entrance" ? 3 : 0}
            >
              <title>{n.label}</title>
            </circle>
          ))}
        </g>
      </svg>
      {DEV && graph.debug && <PlanDebugNumbers debug={graph.debug} plan={graph.plan} />}
    </div>
  );
}

// ── Dev-only plan alignment check ──────────────────────────────────────────────────────────────────────────────
// Red lines are Matterport's walls in the sweeps' frame. If the plan image is placed right, they sit on the drawn walls.
// Magenta dashes are the computed plan box. Off by a constant = offset; mirrored about the box's middle = flip.

type Placed = GraphView["plan"];
const f = (n: number, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : String(n));

function PlanDebugLayer({ debug, plan, H }: { debug: PlanDebug; plan: Placed; H: number }) {
  return (
    <g pointerEvents="none">
      <g stroke="#E53E3E" strokeWidth={2} opacity={0.9}>
        {debug.walls.map((w, i) => <line key={i} x1={w.x1 * W} y1={w.y1 * H} x2={w.x2 * W} y2={w.y2 * H} />)}
      </g>
      <rect x={1} y={1} width={W - 2} height={H - 2} fill="none" stroke="#3182CE" strokeWidth={2} strokeDasharray="4 6" />
      {plan && (
        <rect x={plan.x * W} y={plan.y * H} width={plan.w * W} height={plan.h * H} fill="none" stroke="#D53F8C" strokeWidth={3} strokeDasharray="12 8" />
      )}
    </g>
  );
}

function PlanDebugNumbers({ debug, plan }: { debug: PlanDebug; plan: Placed }) {
  const g = debug.graph;
  const p = debug.plan;
  const lines = [
    `graph   origin (${f(g.originX)}, ${f(g.originY)}) m y-down   size ${f(g.widthM)} × ${f(g.heightM)} m   [blue dashes = 0..1]`,
    p
      ? `plan    ${p.width}×${p.height} px @ ${f(p.resolution, 2)} px/m = ${f(p.widthM)} × ${f(p.heightM)} m   origin (bottom-left, world y-up) (${f(p.originX)}, ${f(p.originY)})`
      : "plan    none for this floor",
    p ? `        floor ${p.planFloorId ?? "(all floors)"}   matched by ${p.matchedBy}` : "",
    p ? `        y-down box x ${f(p.originX)}..${f(p.originX + p.widthM)}   y ${f(-(p.originY + p.heightM))}..${f(-p.originY)} m` : "",
    plan ? `placed  x ${f(plan.x)} y ${f(plan.y)} w ${f(plan.w)} h ${f(plan.h)} (normalized)   [magenta dashes]` : "",
    `walls   ${debug.walls.length} segments [red]   plans available: ${debug.plansAvailable.map((a) => a.floorId ?? "all").join(", ") || "none"}`,
  ].filter(Boolean);
  return (
    <pre className="overflow-x-auto border-t border-card bg-[#FFF5F7] px-3 py-2 font-mono text-[11px] leading-snug text-[#702459]">
      {"DEV plan debug\n" + lines.join("\n")}
    </pre>
  );
}
