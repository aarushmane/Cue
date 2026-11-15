import { lookAhead, progressAlong } from "@/lib/wayfinding/screen";
import { aboutSteps } from "@/lib/wayfinding/steps";
import type { RoutePlan, Vec3 } from "@/lib/wayfinding/types";

export type GuidanceCue = { key: string; text: string; arrived: boolean };
export function guidanceFor(plan: RoutePlan, position: Vec3, heading?: number): GuidanceCue | null {
  if (!("polyline" in plan) || !plan.polyline.length) return null;
  const progress = progressAlong(plan.polyline, position);
  const total = progressAlong(plan.polyline, plan.polyline.at(-1)!).atM;
  const remaining = Math.max(0, total - progress.atM);
  // Use the floor approach point, not the product's elevated shelf coordinates.
  const arrived = Math.hypot(position.x - plan.standPoint.x, position.y - plan.standPoint.y) < 0.65;
  if (arrived) return { key: `${plan.item.id}:arrived`, text: `You've reached ${plan.item.name}.`, arrived: true };
  if (progress.offRouteM > 1.5) return { key: `${plan.item.id}:off-route`, text: "You've moved away from the route. Ask me to guide you again.", arrived: false };
  const ahead = lookAhead(plan.polyline, position, 2);
  const desired = Math.atan2(ahead.y - position.y, ahead.x - position.x) * 180 / Math.PI;
  const difference = heading === undefined ? 0 : ((desired - heading + 540) % 360) - 180;
  const turn = Math.abs(difference) > 155 ? "Turn around" : Math.abs(difference) < 25 ? "Continue ahead"
    : difference > 0 ? "Turn left" : "Turn right";
  const text = heading === undefined ? `${plan.item.name} is ${aboutSteps(remaining)} along the route.`
    : `${turn}. ${aboutSteps(remaining)} remaining to ${plan.item.name}.`;
  return { key: `${plan.item.id}:${heading === undefined ? "unknown" : turn}:${Math.ceil(remaining / 3)}`, text, arrived: false };
}
