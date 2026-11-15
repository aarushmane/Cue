import type { RoutePlan } from "@/lib/wayfinding/types";
import { aboutSteps } from "@/lib/wayfinding/steps";

type OkPlan = Extract<RoutePlan, { status: "OK" | "ALREADY_THERE" }>;

/**
 * Top-down route map: the walked path, direction chevrons, where to stand and the item. Used when the 3D overlay is
 * unavailable (no Showcase SDK key) and as an overview next to the directions.
 */
export function RouteMap({ plan, className }: { plan: OkPlan; className?: string }) {
  const pts = [...plan.polyline, plan.item.position];
  const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
  const pad = 1;
  const w = Math.max(maxX - minX, 2) + pad * 2, h = Math.max(maxY - minY, 2) + pad * 2;
  // Model y points up; SVG y points down.
  const X = (x: number) => x - minX + pad;
  const Y = (y: number) => maxY - y + pad;
  const start = plan.polyline[0];

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={className} role="img" aria-label={`Route map: ${aboutSteps(plan.totalDistanceM)} to ${plan.item.name}`}>
      <polyline
        points={plan.polyline.map((p) => `${X(p.x)},${Y(p.y)}`).join(" ")}
        className="fill-none stroke-primary" strokeWidth={Math.max(w, h) / 45} strokeLinecap="round" strokeLinejoin="round"
      />
      {plan.arrows.map((a) => (
        <path
          key={a.atM}
          d="M 0.22 0 L -0.16 -0.17 L -0.06 0 L -0.16 0.17 Z"
          transform={`translate(${X(a.position.x)} ${Y(a.position.y)}) rotate(${-a.headingDeg}) scale(${Math.max(w, h) / 12})`}
          className="fill-primary-foreground"
        />
      ))}
      <circle cx={X(start.x)} cy={Y(start.y)} r={Math.max(w, h) / 40} className="fill-foreground" />
      <line
        x1={X(plan.standPoint.x)} y1={Y(plan.standPoint.y)} x2={X(plan.item.position.x)} y2={Y(plan.item.position.y)}
        className="stroke-muted-foreground" strokeWidth={Math.max(w, h) / 120} strokeDasharray={`${Math.max(w, h) / 60}`}
      />
      <circle cx={X(plan.item.position.x)} cy={Y(plan.item.position.y)} r={Math.max(w, h) / 28} className="fill-primary stroke-primary-foreground" strokeWidth={Math.max(w, h) / 140} />
    </svg>
  );
}
