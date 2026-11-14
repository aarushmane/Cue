// Data access for shopper-facing reads. Two implementations behind one interface:
//  - SupabaseRepo: real persistence (used whenever NEXT_PUBLIC_SUPABASE_URL is set)
//  - MemoryRepo:   seeded in-memory data, so the app and tests run before Supabase is configured.
// Server-only: never import this from a "use client" component.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Landmark, PublishedProduct, Shelf, StoreGraph } from "../types";
import * as seed from "../seed/demo-store";
import { db as demoDb } from "./demoState";
import { toStoreGraph } from "../map/graph";

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
class MemoryRepo implements StoreRepo {
  readonly kind = "memory" as const;

  async listStores(): Promise<StoreSummary[]> {
    const s = seed.DEMO_STORE;
    return [{ id: s.id, name: s.name, address: s.address, latitude: s.latitude, longitude: s.longitude }];
  }

  async getPublishedGraph(storeId: string): Promise<StoreGraph | null> {
    if (storeId !== seed.DEMO_STORE.id) return null;
    // A floor plan published from the staff editor (v2+) replaces the seeded map for routing.
    const published = demoDb().maps.published;
    if (published.version !== seed.DEMO_MAP.version) return toStoreGraph(published, storeId);
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
    // Starts as the seed; staff approvals and moves (lib/db/demoState.ts) update it, so shopper search and
    // routes pick up a published change on the very next request.
    return demoDb().products.filter((p) => p.storeId === storeId).map((p) => ({ ...p, aliases: [...p.aliases], location: { ...p.location }, shelf: { ...p.shelf } }));
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
          "shelf_id, level, verified_at, products!inner(id, store_id, name, brand, variant, size, aliases), shelves!inner(id, aisle, section)",
        )
        .eq("status", "PUBLISHED")
        .eq("products.store_id", storeId),
    ) as unknown as {
      shelf_id: string;
      level: PublishedProduct["location"]["level"];
      verified_at: string;
      products: { id: string; store_id: string; name: string; brand: string | null; variant: string | null; size: string | null; aliases: string[] };
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
      location: { productId: r.products.id, shelfId: r.shelf_id, level: r.level, verifiedAt: r.verified_at },
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
