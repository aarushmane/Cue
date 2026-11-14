"use client";
// Read-only drawing of an onboarding draft graph: scan points and walkable paths over the twin's floor plan.
// Coordinates are normalized 0..1 (MapNode convention); the plan image may extend past the graph's bounds.
import type { GraphView } from "@/lib/agents/onboarding/view";

const W = 1000;

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
    </div>
  );
}
