import { z } from "zod";
import { getRepo } from "@/lib/db/repo";
import { planRoute } from "@/lib/routing/plan";

const Body = z.object({
  store_id: z.string().min(1).max(100),
  start_node_id: z.string().min(1).max(100),
  product_id: z.string().min(1).max(100),
  map_version: z.number().int().optional(),
});

// POST /api/routes — compute an A* route from a mapped node to a product's verified shelf anchor.
// Always re-reads the published graph and product location, so a staff move changes the very next route.
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ status: "BAD_REQUEST", reason: "store_id, start_node_id and product_id are required" }, { status: 400 });

  const { store_id, start_node_id, product_id, map_version } = parsed.data;
  const repo = getRepo();
  const [graph, products] = await Promise.all([repo.getPublishedGraph(store_id), repo.listPublishedProducts(store_id)]);
  if (!graph) return Response.json({ status: "ROUTE_UNAVAILABLE", reason: "This store has no published map." }, { status: 404 });

  const result = planRoute(graph, start_node_id, products.find((p) => p.id === product_id) ?? null);
  const stale = map_version !== undefined && map_version !== graph.mapVersion;
  const httpStatus = result.status === "OK" || result.status === "ALREADY_THERE" ? 200 : result.status === "START_NODE_INVALID" ? 400 : 404;
  return Response.json({ ...result, map_was_updated: stale }, { status: httpStatus });
}
