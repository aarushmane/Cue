import type { MapEdge, MapNode } from "../types";

export interface Graph {
  nodes: Map<string, MapNode>;
  adj: Map<string, { to: string; weight: number }[]>;
  widthM: number;
  heightM: number;
}

/** Build an undirected adjacency list. Edges referencing unknown nodes are ignored. */
export function buildGraph(nodes: MapNode[], edges: MapEdge[], widthM: number, heightM: number): Graph {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const adj = new Map<string, { to: string; weight: number }[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    if (!nodeMap.has(e.from) || !nodeMap.has(e.to)) continue;
    if (!(e.weight >= 0)) continue;
    adj.get(e.from)!.push({ to: e.to, weight: e.weight });
    adj.get(e.to)!.push({ to: e.from, weight: e.weight });
  }
  return { nodes: nodeMap, adj, widthM, heightM };
}

/** Straight-line distance in meters between two nodes. */
export function metersBetween(g: Graph, a: string, b: string): number {
  const na = g.nodes.get(a)!;
  const nb = g.nodes.get(b)!;
  return Math.hypot((na.x - nb.x) * g.widthM, (na.y - nb.y) * g.heightM);
}

/**
 * A* shortest path. Returns the node-id path (inclusive of start and goal) or null if unreachable.
 * The heuristic is straight-line meters, which is admissible as long as edge weights are ≥ real distance.
 * We scale it by 0.999 so slightly-rounded seed weights never make it inadmissible.
 */
export function astar(g: Graph, start: string, goal: string): { path: string[]; cost: number } | null {
  if (!g.nodes.has(start) || !g.nodes.has(goal)) return null;
  if (start === goal) return { path: [start], cost: 0 };

  const h = (id: string) => metersBetween(g, id, goal) * 0.999;
  const gScore = new Map<string, number>([[start, 0]]);
  const cameFrom = new Map<string, string>();
  const closed = new Set<string>();
  // The graphs are tiny (tens of nodes), so a linear-scan open set is simpler than a heap and fast enough.
  const open = new Map<string, number>([[start, h(start)]]);

  while (open.size > 0) {
    let current = "";
    let best = Infinity;
    for (const [id, f] of open) {
      // Tie-break on id so results are deterministic.
      if (f < best || (f === best && id < current)) {
        best = f;
        current = id;
      }
    }
    if (current === goal) {
      const path = [goal];
      while (cameFrom.has(path[0])) path.unshift(cameFrom.get(path[0])!);
      return { path, cost: gScore.get(goal)! };
    }
    open.delete(current);
    closed.add(current);

    for (const { to, weight } of g.adj.get(current) ?? []) {
      if (closed.has(to)) continue;
      const tentative = gScore.get(current)! + weight;
      if (tentative < (gScore.get(to) ?? Infinity)) {
        cameFrom.set(to, current);
        gScore.set(to, tentative);
        open.set(to, tentative + h(to));
      }
    }
  }
  return null;
}
