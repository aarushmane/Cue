import type { PublishedProduct, RouteResult, StoreGraph } from "../types";
import { astar, buildGraph } from "./astar";
import { buildInstructions } from "./instructions";

/**
 * Route engine entry point (manual §09 pseudocode). Pure: callers load the published graph and product.
 * `product` must be a *published* product (has a verified location) or null.
 */
export function planRoute(graph: StoreGraph, startNodeId: string, product: PublishedProduct | null): RouteResult {
  // 1. Product is published and has a shelf anchor.
  if (!product || product.storeId !== graph.storeId) {
    return { status: "PRODUCT_NOT_PUBLISHED", reason: "That product has no verified location in this store." };
  }
  const shelf = graph.shelves.find((s) => s.id === product.location.shelfId);
  if (!shelf || !graph.nodes.some((n) => n.id === shelf.anchorNodeId)) {
    return { status: "PRODUCT_NOT_PUBLISHED", reason: "The product's shelf is not on the published map." };
  }
  // 2. Start node belongs to this store's map.
  if (!graph.nodes.some((n) => n.id === startNodeId)) {
    return { status: "START_NODE_INVALID", reason: "Your position is not on this store's map." };
  }
  // 3–4. A* over permitted edges.
  const g = buildGraph(graph.nodes, graph.edges, graph.widthM, graph.heightM);
  const found = astar(g, startNodeId, shelf.anchorNodeId);
  if (!found) {
    return { status: "ROUTE_UNAVAILABLE", reason: "No walkable route connects your position to that shelf." };
  }
  // 5. Template instructions.
  const steps = buildInstructions(g, found.path, shelf, { productName: product.name, level: product.location.level });
  if (found.path.length === 1) {
    return { status: "ALREADY_THERE", path: found.path, destinationShelfId: shelf.id, steps, mapVersion: graph.mapVersion };
  }
  return {
    status: "OK",
    path: found.path,
    destinationShelfId: shelf.id,
    totalDistanceM: Math.round(found.cost * 10) / 10,
    steps,
    mapVersion: graph.mapVersion,
  };
}
