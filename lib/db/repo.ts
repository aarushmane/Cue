// Data access for shopper-facing reads. Two implementations behind one interface:
//  - SupabaseRepo: real persistence (used whenever NEXT_PUBLIC_SUPABASE_URL is set)
//  - MemoryRepo:   seeded in-memory data, so the app and tests run before Supabase is configured.
// Server-only: never import this from a "use client" component.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Landmark, Product, ProductLocation, PublishedProduct, Shelf, StoreGraph } from "../types";
import * as seed from "../seed/demo-store";

export interface StoreSummary {
  id: string;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface StoreRepo {
  readonly kind: "supabase" | "memory";
  listStores(): Promise<StoreSummary[]>;
  getPublishedGraph(storeId: string): Promise<StoreGraph | null>;
  listPublishedProducts(storeId: string): Promise<PublishedProduct[]>;
  listLandmarks(storeId: string): Promise<Landmark[]>;
}

// ───────────────────────────── Memory ─────────────────────────────
// Mutable copies so staff edits work in memory mode (and in tests). Reset on server restart.
const memProducts: Product[] = seed.DEMO_PRODUCTS.map((p) => ({ ...p, aliases: [...p.aliases] }));
const memLocations: ProductLocation[] = seed.DEMO_LOCATIONS.map((l) => ({ ...l, lastSeenAt: null, missCount: 0 }));

/** Memory-mode state for the inventory module (lib/inventory). Server-only. */
export function memoryInventory() {
  return { products: memProducts, locations: memLocations, shelves: seed.DEMO_SHELVES };
}

/** Memory-mode: add a product with a published location. */
export function memoryAddProduct(p: Omit<Product, "id">, shelfId: string, level: ProductLocation["level"]): string | null {
  if (!seed.DEMO_SHELVES.some((s) => s.id === shelfId)) return null;
  const id = `P-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  memProducts.push({ ...p, id });
  memLocations.push({ productId: id, shelfId, level, verifiedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), missCount: 0 });
  return id;
}

/** Memory-mode: unpublish a product's location (staff confirmed it is gone). */
export function memoryRetireLocation(productId: string): boolean {
  const i = memLocations.findIndex((l) => l.productId === productId);
  if (i < 0) return false;
  memLocations.splice(i, 1);
  return true;
}

/** Memory-mode equivalent of the move_product SQL function. Returns false for unknown product/shelf. */
export function memoryMoveProduct(productId: string, shelfId: string, level: PublishedProduct["location"]["level"]): boolean {
  const loc = memLocations.find((l) => l.productId === productId);
  if (!loc || !seed.DEMO_SHELVES.some((s) => s.id === shelfId)) return false;
  loc.shelfId = shelfId;
  loc.level = level;
  loc.verifiedAt = new Date().toISOString();
  loc.missCount = 0;
  return true;
}

class MemoryRepo implements StoreRepo {
  readonly kind = "memory" as const;

  async listStores(): Promise<StoreSummary[]> {
    const s = seed.DEMO_STORE;
    return [{ id: s.id, name: s.name, address: s.address, latitude: s.latitude, longitude: s.longitude }];
  }

  async getPublishedGraph(storeId: string): Promise<StoreGraph | null> {
    if (storeId !== seed.DEMO_STORE.id) return null;
    return {
      storeId,
      mapId: seed.DEMO_MAP.id,
      mapVersion: seed.DEMO_MAP.version,
      widthM: seed.DEMO_STORE.widthM,
      heightM: seed.DEMO_STORE.heightM,
      nodes: seed.DEMO_NODES,
      edges: seed.DEMO_EDGES,
      shelves: seed.DEMO_SHELVES,
    };
  }

  async listPublishedProducts(storeId: string): Promise<PublishedProduct[]> {
    if (storeId !== seed.DEMO_STORE.id) return [];
    const shelves = new Map(seed.DEMO_SHELVES.map((s) => [s.id, s]));
    return memProducts.flatMap((p) => {
      const location = memLocations.find((l) => l.productId === p.id);
      const shelf = location && shelves.get(location.shelfId);
      return location && shelf ? [{ ...p, location: { ...location }, shelf: { id: shelf.id, aisle: shelf.aisle, section: shelf.section } }] : [];
    });
  }

  async listLandmarks(storeId: string): Promise<Landmark[]> {
    return storeId === seed.DEMO_STORE.id ? seed.DEMO_LANDMARKS : [];
  }
}

// ───────────────────────────── Supabase ─────────────────────────────
class SupabaseRepo implements StoreRepo {
  readonly kind = "supabase" as const;
  constructor(private db: SupabaseClient) {}

  private must<T>(res: { data: T | null; error: { message: string } | null }): T {
    if (res.error) throw new Error(res.error.message);
    return res.data as T;
  }

  async listStores(): Promise<StoreSummary[]> {
    return this.must(await this.db.from("stores").select("id, name, address, latitude, longitude").order("name"));
  }

  async getPublishedGraph(storeId: string): Promise<StoreGraph | null> {
    const [store, map] = await Promise.all([
      this.db.from("stores").select("width_m, height_m").eq("id", storeId).maybeSingle(),
      this.db.from("store_maps").select("id, version").eq("store_id", storeId).eq("status", "PUBLISHED").maybeSingle(),
    ]);
    const s = this.must(store);
    const m = this.must(map);
    if (!s || !m) return null;
    const [nodes, edges, shelves] = await Promise.all([
      this.db.from("nodes").select("id, x, y, kind, label, facing_deg").eq("map_id", m.id),
      this.db.from("edges").select("id, from_node, to_node, weight").eq("map_id", m.id),
      this.db.from("shelves").select("id, aisle, section, anchor_node, x, y, w, h").eq("map_id", m.id),
    ]);
    return {
      storeId,
      mapId: m.id,
      mapVersion: m.version,
      widthM: s.width_m,
      heightM: s.height_m,
      nodes: this.must(nodes).map((n) => ({ id: n.id, x: n.x, y: n.y, kind: n.kind, label: n.label, facingDeg: n.facing_deg })),
      edges: this.must(edges).map((e) => ({ id: e.id, from: e.from_node, to: e.to_node, weight: e.weight })),
      shelves: this.must(shelves).map(
        (sh): Shelf => ({ id: sh.id, aisle: sh.aisle, section: sh.section, anchorNodeId: sh.anchor_node, x: sh.x, y: sh.y, w: sh.w, h: sh.h }),
      ),
    };
  }

  async listPublishedProducts(storeId: string): Promise<PublishedProduct[]> {
    const rows = this.must(
      await this.db
        .from("product_locations")
        .select(
          "shelf_id, level, verified_at, last_seen_at, miss_count, products!inner(id, store_id, name, brand, variant, size, aliases, category), shelves!inner(id, aisle, section)",
        )
        .eq("status", "PUBLISHED")
        .eq("products.store_id", storeId),
    ) as unknown as {
      shelf_id: string;
      level: PublishedProduct["location"]["level"];
      verified_at: string;
      last_seen_at: string | null;
      miss_count: number;
      products: { id: string; store_id: string; name: string; brand: string | null; variant: string | null; size: string | null; aliases: string[]; category: string | null };
      shelves: { id: string; aisle: string; section: string };
    }[];
    return rows.map((r) => ({
      id: r.products.id,
      storeId: r.products.store_id,
      name: r.products.name,
      brand: r.products.brand,
      variant: r.products.variant,
      size: r.products.size,
      aliases: r.products.aliases ?? [],
      category: r.products.category,
      location: { productId: r.products.id, shelfId: r.shelf_id, level: r.level, verifiedAt: r.verified_at, lastSeenAt: r.last_seen_at, missCount: r.miss_count },
      shelf: r.shelves,
    }));
  }

  async listLandmarks(storeId: string): Promise<Landmark[]> {
    const graph = await this.getPublishedGraph(storeId);
    if (!graph) return [];
    const rows = this.must(
      await this.db.from("landmarks").select("id, node_id, description, image_url").in("node_id", graph.nodes.map((n) => n.id)),
    );
    return rows.map((l) => ({ id: l.id, nodeId: l.node_id, description: l.description, imageUrl: l.image_url }));
  }
}

let cached: StoreRepo | null = null;

export function getRepo(): StoreRepo {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  // Shopper reads use the anon key so row-level security (published-only) is enforced by the database.
  cached = url && key ? new SupabaseRepo(createClient(url, key, { auth: { persistSession: false } })) : new MemoryRepo();
  return cached;
}
