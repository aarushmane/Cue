import { lookAhead, progressAlong } from "@/lib/wayfinding/screen";
import { aboutSteps, stepsFor } from "@/lib/wayfinding/steps";
import type { RoutePlan, Vec3 } from "@/lib/wayfinding/types";

export type GuidanceCue = { key: string; text: string; arrived: boolean };
/**
 * Everything spoken guidance needs at one moment: the full sentence (for stops and arrival), a very short cue for
 * while walking, and a framing hint when the visitor is near the item but it isn't roughly centred in view.
 */
export type GuidanceSnapshot = { cue: GuidanceCue; brief: string | null; framing: string | null; centred: boolean; near: boolean };

/** Eye height above the floor used to judge whether an item is above or below the view centre. */
const EYE_M = 1.5;
/** Within this distance of where to stand, framing hints take over from route cues. */
const NEAR_M = 2.5;

/** Below this speed the visitor counts as standing still. */
const STILL_MPS = 0.15;
/** Arrival: within this floor distance of the item itself, or of where to stand, while looking at it. */
const REACH_M = 1.2;
const STAND_REACH_M = 0.6;
/** Arrival needs the item well inside the view, a tighter zone than the framing hints use. */
const ARRIVE_ZONE = 0.75;

const wrap = (degrees: number) => ((degrees + 540) % 360) - 180;

function routeState(plan: Extract<RoutePlan, { polyline: Vec3[] }>, position: Vec3, heading?: number, speedMps = 0, view: ViewFrame = {}) {
  const progress = progressAlong(plan.polyline, position);
  const total = progressAlong(plan.polyline, plan.polyline.at(-1)!).atM;
  const remaining = Math.max(0, total - progress.atM);
  const toStand = Math.hypot(position.x - plan.standPoint.x, position.y - plan.standPoint.y);
  // Distances are measured on the floor plane, so the eye height (crouching, raised view) never matters; the gaze test
  // projects the item into the real camera, so looking up or down at it from any height counts.
  const toItem = Math.hypot(position.x - plan.item.position.x, position.y - plan.item.position.y);
  const still = speedMps < STILL_MPS;
  const close = toItem <= REACH_M || toStand <= STAND_REACH_M;
  const arrived = still && (heading === undefined
    ? toStand < 0.35 // No known view direction: only the exact stand point counts.
    : close && framingCue(plan, position, heading, view, false, ARRIVE_ZONE).centred);
  const ahead = lookAhead(plan.polyline, position, Math.max(1, Math.min(3, speedMps * 1.5)));
  const desired = Math.atan2(ahead.y - position.y, ahead.x - position.x) * 180 / Math.PI;
  const difference = heading === undefined ? 0 : wrap(desired - heading);
  return { remaining, toStand, arrived, difference, offRoute: progress.offRouteM > 1.5 };
}

export function guidanceFor(plan: RoutePlan, position: Vec3, heading?: number, speedMps = 0, view: ViewFrame = {}): GuidanceCue | null {
  if (!("polyline" in plan) || !plan.polyline.length) return null;
  const { remaining, arrived, difference, offRoute } = routeState(plan, position, heading, speedMps, view);
  if (arrived) return { key: `${plan.item.id}:arrived`, text: `You've reached ${plan.item.name}.`, arrived: true };
  if (offRoute) return { key: `${plan.item.id}:off-route`, text: "You've moved away from the route. Ask me to guide you again.", arrived: false };
  const turn = Math.abs(difference) > 155 ? "Turn around" : Math.abs(difference) < 25 ? "Continue ahead"
    : difference > 0 ? "Turn left" : "Turn right";
  const text = heading === undefined ? `${plan.item.name} is ${aboutSteps(remaining)} along the route.`
    : `${turn}. ${aboutSteps(remaining)} remaining to ${plan.item.name}.`;
  return { key: `${plan.item.id}:${heading === undefined ? "unknown" : turn}:${Math.ceil(remaining / 3)}`, text, arrived: false };
}

/** A few words while walking: "Bit to the left.", "Just 2 more steps.", "Straight on." */
export function briefCue(plan: RoutePlan, position: Vec3, heading?: number, speedMps = 0, view: ViewFrame = {}): string | null {
  if (!("polyline" in plan) || !plan.polyline.length) return null;
  const { remaining, arrived, difference, offRoute } = routeState(plan, position, heading, speedMps, view);
  if (arrived) return null;
  if (offRoute) return "Off the route.";
  const side = difference > 0 ? "left" : "right";
  if (Math.abs(difference) > 155) return "Turn around.";
  if (Math.abs(difference) > 45) return `Turn ${side}.`;
  const steps = stepsFor(remaining);
  if (steps <= 5) return steps === 1 ? "Just one more step." : `Just ${steps} more steps.`;
  if (Math.abs(difference) > 20) return `Bit to the ${side}.`;
  return "Straight on.";
}

/** The camera the visitor sees through, when the viewer knows it. Missing fields fall back to typical values. */
export type ViewFrame = { eye?: Vec3; vfovDeg?: number; aspect?: number; pitchDeg?: number };
export type Framing = { text: string | null; centred: boolean };

/** Rough half-size of an item on the shelf: up close it fills much of the view, so the tolerance grows with it. */
const ITEM_RADIUS_M = 0.3;
const DEFAULT_VFOV = 75;
const DEFAULT_ASPECT = 16 / 9;
/** The item counts as looked at when (any part of) it is within this fraction of the half-view from the centre. */
const ZONE = 0.5;
/** Once looked at, it stays looked at until it leaves a zone this much larger (stops flip-flopping at the edge). */
const HOLD = 1.4;
const DEG = 180 / Math.PI;

/**
 * Near the item: is it in the middle of what the visitor actually sees? The item is projected into the real camera
 * (eye height, heading, tilt, field of view, aspect) and treated as a small object rather than a point, so standing
 * right up against it still counts. Returns a hint ("a bit to your left", "lower down") when it isn't centred.
 */
export function framingCue(plan: RoutePlan, position: Vec3, heading?: number, view: ViewFrame = {}, wasCentred = false, zone = ZONE): Framing {
  if (!("polyline" in plan) || heading === undefined) return { text: null, centred: false };
  const item = plan.item.position;
  const name = plan.item.name;
  const eye = view.eye ?? { ...position, z: position.z + EYE_M };
  const tilt = view.pitchDeg;
  const yaw = heading / DEG, pitch = (tilt ?? 0) / DEG;
  // Camera basis in the z-up model frame (heading 0° = +x, counter-clockwise).
  const fwd = { x: Math.cos(pitch) * Math.cos(yaw), y: Math.cos(pitch) * Math.sin(yaw), z: Math.sin(pitch) };
  const right = { x: Math.sin(yaw), y: -Math.cos(yaw), z: 0 };
  const up = { x: -Math.sin(pitch) * Math.cos(yaw), y: -Math.sin(pitch) * Math.sin(yaw), z: Math.cos(pitch) };
  const d = { x: item.x - eye.x, y: item.y - eye.y, z: item.z - eye.z };
  const dot = (a: Vec3) => a.x * d.x + a.y * d.y + a.z * d.z;
  const ahead = dot(fwd), across = dot(right), above = dot(up);
  const dist = Math.max(Math.hypot(d.x, d.y, d.z), 0.05);
  // Angles from the view centre (+h = right, +v = up). With no known tilt the basis is level, so h is the floor-plane
  // offset and only it is judged.
  const h = Math.atan2(across, ahead) * DEG;
  const v = Math.atan2(above, ahead) * DEG;
  const halfV = (view.vfovDeg ?? DEFAULT_VFOV) / 2;
  const halfH = Math.atan(Math.tan(halfV / DEG) * (view.aspect ?? DEFAULT_ASPECT)) * DEG;
  const size = Math.atan(ITEM_RADIUS_M / dist) * DEG;
  const grow = wasCentred ? HOLD : 1;
  const zoneH = Math.max(12, halfH * zone) * grow, zoneV = Math.max(12, halfV * zone) * grow;
  const offH = Math.abs(h) - size > zoneH;
  const offV = tilt !== undefined && Math.abs(v) - size > zoneV;
  if (!offH && !offV && (ahead > 0 || dist < ITEM_RADIUS_M)) return { text: null, centred: true };
  if (Math.abs(h) > 120) return { text: `${name} is behind you.`, centred: false };
  if (offH || ahead <= 0) return { text: `${name} is ${Math.abs(h) > 50 ? "to your" : "a bit to your"} ${h > 0 ? "right" : "left"}.`, centred: false };
  return { text: `${name} is ${v > 0 ? "higher up" : "lower down"}.`, centred: false };
}

export function guidanceSnapshot(plan: RoutePlan, position: Vec3, heading?: number, speedMps = 0, view: ViewFrame = {}, wasCentred = false): GuidanceSnapshot | null {
  const cue = guidanceFor(plan, position, heading, speedMps, view);
  if (!cue || !("polyline" in plan)) return null;
  const { toStand } = routeState(plan, position, heading, speedMps, view);
  const near = cue.arrived || toStand < NEAR_M;
  const framed = near ? framingCue(plan, position, heading, view, wasCentred) : { text: null, centred: false };
  return { cue, brief: briefCue(plan, position, heading, speedMps, view), framing: framed.text, centred: framed.centred, near };
}
