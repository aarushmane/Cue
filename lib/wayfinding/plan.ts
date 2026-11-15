// Route planning to an item, avoiding obstacles.
//
// Graph: Matterport scan points are nodes; the scanner's own neighbour links are edges (it was carried along them,
// so they are walkable and obstacle-free). Every edge the planner adds itself — from a free start position, proximity
// fallbacks, smoothing shortcuts, line of sight to the item — is checked against walls and shelf boxes with a clearance.
// Goal: the reachable scan point that minimises (walking cost + distance to the item) and can see the item.
// Directions and arrows are generated from geometry with fixed templates; no LLM writes them.
import { classifyTurn } from "./turns";
import { dist2, headingDeg, length, lerp, normalize, segmentBlocked, segmentDistance, sub, turnDeg, v3 } from "./geometry";
import { raycast } from "./mesh";
import { aboutSteps } from "./steps";
import { segmentWalkable, type WalkGrid } from "./walkable";
import type { Obstacle, RouteArrow, RouteLeg, RoutePlan, SceneItem, StartPoint, Turn, Vec3, Waypoint, WayfindingScene } from "./types";

export interface PlanOptions {
  /** Keep this far from walls and shelves on planner-added edges (metres). */
  clearanceM?: number;
  /** Only scan points within this floor distance of the item count as places to stand. */
  maxApproachM?: number;
  /**
   * Weight of "distance from stand point to item" against walking distance when choosing where to stop. Standing
   * close enough to see the item matters more than a few extra steps, so each metre of distance costs 3 m of walking.
   */
  approachWeight?: number;
  /** Gap between floor arrows (metres). */
  arrowSpacingM?: number;
  /** Shortcut corners where the straight line is clear and stays within `corridorM` of the scanned path. */
  smooth?: boolean;
  corridorM?: number;
  /** Used only when no scan point has neighbour data: connect scan points closer than this. */
  proximityEdgeM?: number;
}

const DEFAULTS: Required<PlanOptions> = {
  clearanceM: 0.3, maxApproachM: 6, approachWeight: 3, arrowSpacingM: 0.8, smooth: true, corridorM: 1, proximityEdgeM: 4,
};

const START = "__start__";

const onFloor = (o: Obstacle, floorId: string | null | undefined) => o.floorId == null || floorId == null || o.floorId === floorId;
const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

function clear(a: Vec3, b: Vec3, obstacles: Obstacle[], floorId: string | null | undefined, clearance: number, ignore?: (o: Obstacle) => boolean, walk?: WalkGrid, walkClearance = Math.min(clearance, 0.25)) {
  // On the mesh's walkable floor, a planner-added edge must also keep (a little less than) its clearance there.
  if (walk && !segmentWalkable(walk, a, b, walkClearance)) return false;
  return !obstacles.some((o) => onFloor(o, floorId) && !(ignore?.(o)) && segmentBlocked(a, b, o, clearance));
}

/** Dijkstra over a small adjacency list. Graphs are scan points (tens to hundreds), so a linear scan is fine. */
function dijkstra(adj: Map<string, { to: string; w: number }[]>, source: string) {
  const dist = new Map<string, number>([[source, 0]]);
  const prev = new Map<string, string>();
  const done = new Set<string>();
  for (;;) {
    let u: string | null = null;
    let best = Infinity;
    for (const [id, d] of dist) if (!done.has(id) && (d < best || (d === best && u !== null && id < u))) { best = d; u = id; }
    if (u === null) break;
    done.add(u);
    for (const { to, w } of adj.get(u) ?? []) {
      const nd = best + w;
      if (nd < (dist.get(to) ?? Infinity)) { dist.set(to, nd); prev.set(to, u); }
    }
  }
  return { dist, prev };
}

/** Turn wording uses the shared classifier, which expects positive = right; our angles are positive = left. */
const turnOf = (leftPositiveDeg: number): Turn => classifyTurn(-leftPositiveDeg);

const TURN_PHRASE: Record<Turn, string> = {
  straight: "Continue straight", slight_left: "Bear slightly left", slight_right: "Bear slightly right",
  left: "Turn left", right: "Turn right", around: "Turn around",
};


/** Where the item is relative to someone who walked in along `headingIn` and now stands at `at`. */
export function sideOf(headingIn: number, at: Vec3, item: Vec3): "ahead" | "behind" | "left" | "right" {
  if (dist2(at, item) < 0.25) return "ahead";
  const rel = turnDeg(headingIn, headingDeg(at, item));
  if (Math.abs(rel) <= 35) return "ahead";
  if (Math.abs(rel) >= 145) return "behind";
  return rel > 0 ? "left" : "right";
}

export function planRouteToItem(scene: WayfindingScene, start: StartPoint, item: SceneItem, options: PlanOptions = {}): RoutePlan {
  // Ignore options passed as undefined (e.g. unset API fields) instead of letting them erase the defaults.
  const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) } as Required<PlanOptions>;
  const warnings: string[] = [];
  const byId = new Map(scene.waypoints.map((w) => [w.id, w]));
  if (!scene.waypoints.length) return { status: "NO_ROUTE", reason: "This space has no scan points to walk between." };

  // ── Graph ──
  const adj = new Map<string, { to: string; w: number }[]>();
  const link = (a: string, b: string, w: number) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    if (!adj.get(a)!.some((e) => e.to === b)) adj.get(a)!.push({ to: b, w });
    if (!adj.get(b)!.some((e) => e.to === a)) adj.get(b)!.push({ to: a, w });
  };
  const hasNeighbors = scene.waypoints.some((w) => w.neighbors.length);
  for (const w of scene.waypoints) {
    adj.set(w.id, adj.get(w.id) ?? []);
    for (const n of w.neighbors) {
      const other = byId.get(n);
      if (other) link(w.id, other.id, length(sub(w.position, other.position)));
    }
  }
  if (!hasNeighbors) {
    warnings.push(`Scan points have no neighbour data; walkable links were inferred (≤ ${o.proximityEdgeM} m, clear of obstacles).`);
    for (const a of scene.waypoints) {
      for (const b of scene.waypoints) {
        if (a.id < b.id && a.floorId === b.floorId && dist2(a.position, b.position) <= o.proximityEdgeM && clear(a.position, b.position, scene.obstacles, a.floorId, 0.1, undefined, scene.walk)) {
          link(a.id, b.id, length(sub(a.position, b.position)));
        }
      }
    }
  }

  // ── Start ──
  let startId: string;
  let startPos: Vec3;
  let startFloor: string | null;
  if ("sweepId" in start) {
    const w = byId.get(start.sweepId);
    if (!w) return { status: "START_INVALID", reason: "That scan point is not part of this space." };
    startId = w.id;
    startPos = w.position;
    startFloor = w.floorId;
  } else {
    startId = START;
    startPos = start.position;
    const near = scene.waypoints
      .filter((w) => start.floorId == null || w.floorId === start.floorId)
      .map((w) => ({ w, d: dist2(w.position, start.position) }))
      .filter(({ w, d }) => d <= 6 && clear(start.position, w.position, scene.obstacles, w.floorId, 0.15, undefined, scene.walk, 0.03))
      .sort((a, b) => a.d - b.d)
      .slice(0, 4);
    if (!near.length) return { status: "START_INVALID", reason: "Your position is not near any scan point with a clear path." };
    startFloor = start.floorId ?? near[0].w.floorId;
    for (const { w, d } of near) link(START, w.id, d);
  }

  // ── Where to stand ──
  const { dist, prev } = dijkstra(adj, startId);
  // Line of sight stops just short of the item, so the shelf it sits on still blocks views from the far side:
  // chips on the back face of a shelf are visible from the back aisle only.
  const sees = (w: Waypoint, ignore?: (ob: Obstacle) => boolean) => {
    const d = dist2(w.position, item.position);
    const end = d > 0.1 ? lerp(w.position, item.position, (d - 0.05) / d) : w.position;
    if (!clear(w.position, end, scene.obstacles, w.floorId, 0, ignore)) return false;
    // With the scan mesh: from eye height, nothing may sit between the visitor and the item (the item itself is on a
    // surface, so a hit within 30 cm of it still counts as seeing it).
    if (scene.surfaces?.length && w.camera) {
      const to = sub(item.position, w.camera);
      const range = length(to);
      if (range > 0.4) {
        const hit = raycast(scene.surfaces, { origin: w.camera, dir: normalize(to) }, 0.2, range);
        if (hit !== null && hit < range - 0.3) return false;
      }
    }
    return true;
  };
  const rank = (ignore?: (ob: Obstacle) => boolean) => scene.waypoints
    .filter((w) => dist.has(w.id) && (item.floorId == null || w.floorId == null || w.floorId === item.floorId))
    .map((w) => ({ w, reach: dist2(w.position, item.position) }))
    .filter(({ w, reach }) => reach <= o.maxApproachM && sees(w, ignore))
    // Within arm's-length-plus (1.5 m) every spot sees the item equally well; past that, distance costs. A scan point
    // with a real photo beats an aisle point (a reconstructed view) unless the aisle point saves more than 1.5 m.
    .map(({ w, reach }) => ({ w, score: dist.get(w.id)! + o.approachWeight * Math.max(0, reach - 1.5) + (w.kind === "aisle" ? 1.5 : 0) }))
    .sort((a, b) => a.score - b.score);
  let candidates = rank();
  if (!candidates.length) {
    // The item's position may be inside its fixture (which face it is on is unknown). Only then let that fixture
    // stop blocking, and say so. An item on a box's surface keeps the box as a blocker.
    const p = item.position;
    const holdsItem = (ob: Obstacle) => ob.kind === "box" && p.x > ob.minX + 0.01 && p.x < ob.maxX - 0.01 && p.y > ob.minY + 0.01 && p.y < ob.maxY - 0.01;
    candidates = rank(holdsItem);
    if (candidates.length) warnings.push("The item's position is inside its shelf, so which side faces the aisle is unknown.");
  }
  if (!candidates.length) {
    const anyNear = scene.waypoints.some((w) => dist2(w.position, item.position) <= o.maxApproachM);
    return anyNear
      ? { status: "NO_APPROACH", reason: "Every scan point near that item is cut off from you or has no clear view of it." }
      : { status: "NO_APPROACH", reason: `No scan point lies within ${o.maxApproachM} m of that item.` };
  }
  const goal = candidates[0].w;

  // ── Path ──
  const ids = [goal.id];
  while (prev.has(ids[0])) ids.unshift(prev.get(ids[0])!);
  const nodes = ids.map((id) => (id === START ? { id: null as string | null, p: startPos, floor: startFloor } : { id, p: byId.get(id)!.position, floor: byId.get(id)!.floorId }));
  const waypointIds = ids.filter((id) => id !== START);
  const facingDeg = round(headingDeg(goal.position, item.position));

  if (nodes.length === 1 || length(sub(nodes[0].p, goal.position)) < 0.05) {
    // Already at the best spot: the only direction left is which way to look.
    const near = `${item.name} is ${aboutSteps(dist2(goal.position, item.position))} from here.`;
    return {
      status: "ALREADY_THERE", item, waypointIds: [goal.id], polyline: [goal.position], standPoint: goal.position, facingDeg,
      legs: [{ index: 0, from: goal.position, to: goal.position, toWaypointId: goal.id, distanceM: 0, headingDeg: facingDeg, turn: null, text: near }],
      arrows: [], totalDistanceM: 0, warnings,
    };
  }

  // ── Smoothing (string pulling), bounded to the scanned corridor ──
  let kept = nodes;
  if (o.smooth && nodes.length > 2) {
    kept = [nodes[0]];
    let i = 0;
    while (i < nodes.length - 1) {
      let j = nodes.length - 1;
      for (; j > i + 1; j--) {
        const a = nodes[i].p, b = nodes[j].p;
        const sameFloor = nodes.slice(i, j + 1).every((n) => n.floor === nodes[i].floor);
        const nearCorridor = nodes.slice(i + 1, j).every((n) => segmentDistance(a.x, a.y, b.x, b.y, n.p.x, n.p.y, n.p.x, n.p.y) <= o.corridorM);
        if (sameFloor && nearCorridor && clear(a, b, scene.obstacles, nodes[i].floor, o.clearanceM, undefined, scene.walk)) break;
      }
      kept.push(nodes[j]);
      i = j;
    }
  }
  const polyline = kept.map((n) => n.p);

  // ── Legs ──
  const segments = kept.slice(1).map((n, k) => ({ from: kept[k].p, to: n.p, toId: n.id, heading: headingDeg(kept[k].p, n.p), d: length(sub(n.p, kept[k].p)) }));
  const merged: typeof segments = [];
  for (const s of segments) {
    const last = merged.at(-1);
    if (last && turnOf(turnDeg(last.heading, s.heading)) === "straight") {
      merged[merged.length - 1] = { from: last.from, to: s.to, toId: s.toId, heading: headingDeg(last.from, s.to), d: last.d + s.d };
    } else merged.push({ ...s });
  }
  const legs: RouteLeg[] = merged.map((s, k) => {
    const turn = k === 0 ? null : turnOf(turnDeg(merged[k - 1].heading, s.heading));
    const text = k === 0 ? `Head this way for ${aboutSteps(s.d)}.` : `${TURN_PHRASE[turn!]} and walk ${aboutSteps(s.d)}.`;
    return { index: k, from: s.from, to: s.to, toWaypointId: s.toId, distanceM: round(s.d), headingDeg: round(s.heading), turn, text };
  });
  const side = sideOf(merged.at(-1)!.heading, goal.position, item.position);
  const where = side === "ahead" ? "ahead of you" : side === "behind" ? "behind you" : `on your ${side}`;
  legs.push({
    index: legs.length, from: goal.position, to: goal.position, toWaypointId: goal.id, distanceM: 0,
    headingDeg: facingDeg, turn: null,
    text: `${item.name} is ${where}, ${aboutSteps(dist2(goal.position, item.position))} away.`,
  });

  // ── Arrows ──
  const total = segments.reduce((sum, s) => sum + s.d, 0);
  const arrows: RouteArrow[] = [];
  let walked = 0;
  let next = Math.min(o.arrowSpacingM / 2, total / 2);
  for (const s of segments) {
    while (next <= walked + s.d && next <= total - 0.3) {
      const t = s.d > 0 ? (next - walked) / s.d : 0;
      const p = lerp(s.from, s.to, t);
      arrows.push({ position: v3(p.x, p.y, p.z + 0.02), headingDeg: round(s.heading), atM: round(next, 2) });
      next += o.arrowSpacingM;
    }
    walked += s.d;
  }

  if (item.source === "vision" && (item.confidence ?? 0) < 0.5) warnings.push("The item's position is a low-confidence estimate from photos.");
  return {
    status: "OK", item, waypointIds, polyline, standPoint: goal.position, facingDeg, legs, arrows,
    totalDistanceM: round(total), warnings,
  };
}

/** Plan to each candidate place and keep the shortest walk (an item may be stocked in more than one spot). */
export function planToNearest(scene: WayfindingScene, start: StartPoint, items: SceneItem[], options: PlanOptions = {}): { item: SceneItem; plan: RoutePlan } | null {
  let best: { item: SceneItem; plan: RoutePlan } | null = null;
  let fallback: { item: SceneItem; plan: RoutePlan } | null = null;
  for (const item of items) {
    const plan = planRouteToItem(scene, start, item, options);
    if (plan.status === "OK" || plan.status === "ALREADY_THERE") {
      if (!best || (best.plan.status === "OK" || best.plan.status === "ALREADY_THERE") && plan.totalDistanceM < best.plan.totalDistanceM) best = { item, plan };
    } else fallback ??= { item, plan };
  }
  return best ?? fallback;
}

export type { Waypoint };
