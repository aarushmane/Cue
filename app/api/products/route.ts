import { z } from "zod";
import { getRepo } from "@/lib/db/repo";
import { describeProduct, resolveProduct, searchProducts } from "@/lib/search/matchProducts";

const Query = z.object({
  store_id: z.string().min(1).max(100),
  query: z.string().max(200).default(""),
});

// GET /api/products?store_id=demo-store&query=almond%20milk
// Searches PUBLISHED inventory only. Response includes a resolution so the shopper UI knows whether to
// route immediately, ask the shopper to choose a variant, or ask them to rephrase.
export async function GET(request: Request) {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const parsed = Query.safeParse(params);
  if (!parsed.success) return Response.json({ error: "store_id is required" }, { status: 400 });

  const { store_id, query } = parsed.data;
  const products = await getRepo().listPublishedProducts(store_id);

  if (!query.trim()) {
    return Response.json({ resolution: { status: "NO_MATCH" }, results: products.map((p) => ({ product: p, score: 0, spoken: describeProduct(p) })) });
  }
  const results = searchProducts(query, products).map((r) => ({ ...r, spoken: describeProduct(r.product) }));
  const resolution = resolveProduct(query, products);
  return Response.json({
    resolution:
      resolution.status === "MATCH"
        ? { status: "MATCH", product_id: resolution.product.id }
        : resolution.status === "AMBIGUOUS"
          ? { status: "AMBIGUOUS", product_ids: resolution.options.map((p) => p.id) }
          : { status: "NO_MATCH" },
    results,
  });
}
