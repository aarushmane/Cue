// Single source of truth for the demo store.
// - Used directly by the in-memory repo when Supabase env vars are missing (local dev / demo backup).
// - `npm run seed:sql` regenerates supabase/seed.sql from this file.
//
// Layout (matches manual p.5): four aisles A1–A4 standing vertically, three walkways W1–W3 between them,
// a top cross-corridor and a bottom corridor running from the entrance (bottom-left) to the help desk (bottom-right).
//
//        N06 ─────── N07 ─────── N08            (top corridor, y=0.10)
//   [A1]  │   [A2]    │   [A3]    │   [A4]
//        N11         N14         N17            (section 3, y=0.27)
//        N10         N13         N16            (section 2, y=0.475)
//        N09         N12         N15            (section 1, y=0.68)
//  N01 ─ N02 ─────── N03 ─────── N04 ──── N05   (bottom corridor, y=0.85)
//  entrance                            help desk

import type { Landmark, MapEdge, MapNode, Product, ProductLocation, Shelf, ShelfLevel } from "../types";

export const DEMO_STORE = {
  id: "demo-store",
  name: "StoreGuide Demo Market",
  address: "HackPrinceton demo floor",
  latitude: 40.3487,
  longitude: -74.6593,
  widthM: 30,
  heightM: 20,
  floorPlanUrl: "/demo/floorplan.svg",
};

export const DEMO_MAP = { id: "map-demo-v1", storeId: DEMO_STORE.id, version: 1, status: "PUBLISHED" as const };

const W = { 1: 0.29, 2: 0.51, 3: 0.73 } as const; // walkway x positions
const SEC_Y = { 1: 0.68, 2: 0.475, 3: 0.27 } as const; // section approach y positions
const TOP_Y = 0.1;
const BOTTOM_Y = 0.85;

export const DEMO_NODES: MapNode[] = [
  { id: "N01", x: 0.07, y: BOTTOM_Y, kind: "entrance", label: "the entrance" },
  { id: "N02", x: W[1], y: BOTTOM_Y, kind: "aisle_marker", label: "the front of the walkway between Aisles 1 and 2" },
  { id: "N03", x: W[2], y: BOTTOM_Y, kind: "aisle_marker", label: "the front of the walkway between Aisles 2 and 3" },
  { id: "N04", x: W[3], y: BOTTOM_Y, kind: "aisle_marker", label: "the front of the walkway between Aisles 3 and 4" },
  { id: "N05", x: 0.95, y: BOTTOM_Y, kind: "service", label: "the help desk" },
  { id: "N06", x: W[1], y: TOP_Y, kind: "junction", label: "the back corridor at Aisle 1" },
  { id: "N07", x: W[2], y: TOP_Y, kind: "junction", label: "the back corridor at Aisle 2" },
  { id: "N08", x: W[3], y: TOP_Y, kind: "junction", label: "the back corridor at Aisle 3" },
  ...([1, 2, 3] as const).flatMap((w, wi) =>
    ([1, 2, 3] as const).map((s, si) => ({
      id: `N${String(9 + wi * 3 + si).padStart(2, "0")}`,
      x: W[w],
      y: SEC_Y[s],
      kind: "shelf_approach" as const,
      label: `section ${s} of the walkway between Aisles ${w} and ${w + 1}`,
    })),
  ),
];

function dist(a: string, b: string): number {
  const na = DEMO_NODES.find((n) => n.id === a)!;
  const nb = DEMO_NODES.find((n) => n.id === b)!;
  const dx = (na.x - nb.x) * DEMO_STORE.widthM;
  const dy = (na.y - nb.y) * DEMO_STORE.heightM;
  return Math.round(Math.hypot(dx, dy) * 10) / 10;
}

const EDGE_PAIRS: [string, string][] = [
  // bottom corridor
  ["N01", "N02"], ["N02", "N03"], ["N03", "N04"], ["N04", "N05"],
  // top corridor
  ["N06", "N07"], ["N07", "N08"],
  // walkway 1
  ["N02", "N09"], ["N09", "N10"], ["N10", "N11"], ["N11", "N06"],
  // walkway 2
  ["N03", "N12"], ["N12", "N13"], ["N13", "N14"], ["N14", "N07"],
  // walkway 3
  ["N04", "N15"], ["N15", "N16"], ["N16", "N17"], ["N17", "N08"],
];

export const DEMO_EDGES: MapEdge[] = EDGE_PAIRS.map(([from, to], i) => ({
  id: `E${String(i + 1).padStart(2, "0")}`,
  from,
  to,
  weight: dist(from, to),
}));

// Aisle centre x and the walkway its shoppable face opens onto.
const AISLES: Record<string, { x: number; walkway: 1 | 2 | 3 }> = {
  "1": { x: 0.18, walkway: 1 }, // east face → W1
  "2": { x: 0.4, walkway: 2 }, // east face → W2
  "3": { x: 0.62, walkway: 3 }, // east face → W3
  "4": { x: 0.84, walkway: 3 }, // west face → W3
};
const AISLE_W = 0.07;
const SECTION_H = 0.19;

export const DEMO_SHELVES: Shelf[] = Object.entries(AISLES).flatMap(([aisle, a]) =>
  ([1, 2, 3] as const).map((s) => {
    const approachIdx = 9 + (a.walkway - 1) * 3 + (s - 1);
    return {
      id: `S-A${aisle}-${s}`,
      aisle,
      section: String(s),
      anchorNodeId: `N${String(approachIdx).padStart(2, "0")}`,
      x: a.x - AISLE_W / 2,
      y: SEC_Y[s] - SECTION_H / 2,
      w: AISLE_W,
      h: SECTION_H,
    };
  }),
);

export const DEMO_LANDMARKS: Landmark[] = [
  { id: "L01", nodeId: "N01", description: "Entrance doors with a green STOREGUIDE welcome sign", imageUrl: "/demo/landmarks/L01.jpg" },
  { id: "L02", nodeId: "N02", description: "Hanging sign reading AISLE 1 – PRODUCE & BAKERY (red)", imageUrl: "/demo/landmarks/L02.jpg" },
  { id: "L03", nodeId: "N03", description: "Hanging sign reading AISLE 2 – DAIRY (blue)", imageUrl: "/demo/landmarks/L03.jpg" },
  { id: "L04", nodeId: "N04", description: "Hanging sign reading AISLE 3 – PANTRY (yellow)", imageUrl: "/demo/landmarks/L04.jpg" },
  { id: "L05", nodeId: "N05", description: "Help desk counter with a bell and a HELP sign", imageUrl: "/demo/landmarks/L05.jpg" },
];

type SeedProduct = Omit<Product, "storeId"> & { shelfId: string; level: ShelfLevel };

const P: SeedProduct[] = [
  // Aisle 1 — produce & bakery
  { id: "P01", name: "Bananas", brand: null, variant: null, size: "per bunch", aliases: ["banana"], shelfId: "S-A1-1", level: "middle" },
  { id: "P02", name: "Gala Apples", brand: null, variant: null, size: "3 lb bag", aliases: ["apples", "apple"], shelfId: "S-A1-1", level: "lower" },
  { id: "P03", name: "Whole Wheat Bread", brand: "Nature's Own", variant: "whole wheat", size: "20 oz", aliases: ["bread", "wheat bread", "loaf"], shelfId: "S-A1-2", level: "middle" },
  { id: "P04", name: "Plain Bagels", brand: "Thomas'", variant: "plain", size: "6 pack", aliases: ["bagels", "bagel"], shelfId: "S-A1-2", level: "upper" },
  { id: "P05", name: "Baby Spinach", brand: "Organic Girl", variant: "organic", size: "5 oz", aliases: ["spinach", "salad greens"], shelfId: "S-A1-3", level: "middle" },
  // Aisle 2 — dairy & alternatives
  { id: "P06", name: "Unsweetened Almond Milk", brand: "Silk", variant: "unsweetened", size: "64 oz", aliases: ["almond milk", "almondmilk", "nut milk"], shelfId: "S-A2-1", level: "middle" },
  { id: "P07", name: "Original Almond Milk", brand: "Blue Diamond Almond Breeze", variant: "original", size: "32 oz", aliases: ["almond milk", "almond breeze"], shelfId: "S-A2-1", level: "upper" },
  { id: "P08", name: "Whole Milk", brand: "Horizon Organic", variant: "whole", size: "half gallon", aliases: ["milk", "whole milk", "dairy milk"], shelfId: "S-A2-1", level: "lower" },
  { id: "P09", name: "Oat Milk", brand: "Oatly", variant: "original", size: "64 oz", aliases: ["oatmilk", "oat milk"], shelfId: "S-A2-2", level: "middle" },
  { id: "P10", name: "Large Eggs", brand: "Eggland's Best", variant: "large", size: "12 count", aliases: ["eggs", "egg", "dozen eggs"], shelfId: "S-A2-2", level: "lower" },
  { id: "P11", name: "Greek Yogurt", brand: "Chobani", variant: "plain", size: "32 oz", aliases: ["yogurt", "yoghurt"], shelfId: "S-A2-3", level: "middle" },
  { id: "P12", name: "Cheddar Cheese", brand: "Tillamook", variant: "sharp", size: "8 oz block", aliases: ["cheese", "cheddar"], shelfId: "S-A2-3", level: "upper" },
  // Aisle 3 — pantry
  { id: "P13", name: "Spaghetti", brand: "Barilla", variant: null, size: "16 oz", aliases: ["pasta", "noodles"], shelfId: "S-A3-1", level: "middle" },
  { id: "P14", name: "Marinara Sauce", brand: "Rao's", variant: "marinara", size: "24 oz", aliases: ["pasta sauce", "tomato sauce", "sauce"], shelfId: "S-A3-1", level: "upper" },
  { id: "P15", name: "Long Grain White Rice", brand: "Mahatma", variant: "white", size: "5 lb", aliases: ["rice", "white rice"], shelfId: "S-A3-2", level: "lower" },
  { id: "P16", name: "Creamy Peanut Butter", brand: "Jif", variant: "creamy", size: "16 oz", aliases: ["peanut butter", "pb"], shelfId: "S-A3-2", level: "middle" },
  { id: "P17", name: "Honey Nut Cheerios", brand: "General Mills", variant: "honey nut", size: "15.4 oz", aliases: ["cheerios", "cereal"], shelfId: "S-A3-3", level: "middle" },
  { id: "P18", name: "Ground Coffee", brand: "Dunkin'", variant: "original blend", size: "12 oz", aliases: ["coffee"], shelfId: "S-A3-3", level: "upper" },
  // Aisle 4 — household & snacks
  { id: "P19", name: "Paper Towels", brand: "Bounty", variant: "select-a-size", size: "6 rolls", aliases: ["paper towel", "towels"], shelfId: "S-A4-1", level: "bottom" },
  { id: "P20", name: "Dish Soap", brand: "Dawn", variant: "original", size: "19.4 oz", aliases: ["dishwashing liquid", "soap"], shelfId: "S-A4-1", level: "middle" },
  { id: "P21", name: "Sea Salt Potato Chips", brand: "Kettle Brand", variant: "sea salt", size: "8 oz", aliases: ["chips", "potato chips", "crisps"], shelfId: "S-A4-2", level: "middle" },
  { id: "P22", name: "Dark Chocolate Bar", brand: "Lindt", variant: "70% cocoa", size: "3.5 oz", aliases: ["chocolate", "candy bar"], shelfId: "S-A4-3", level: "upper" },
];

const SEED_VERIFIED_AT = "2026-11-14T00:00:00.000Z";

/** Staff-facing product categories (v4 design handoff). */
export const CATEGORIES = ["Produce", "Bakery", "Dairy", "Dairy alternatives", "Pantry", "Breakfast", "Household", "Snacks"] as const;

/** Display names for aisles, used on staff screens and in detailed shopper speech. */
export const AISLE_NAMES: Record<string, string> = {
  "1": "Produce & Bakery",
  "2": "Dairy & Alternatives",
  "3": "Pantry",
  "4": "Household & Snacks",
};

const CATEGORY_BY_ID: Record<string, string> = {
  P01: "Produce", P02: "Produce", P03: "Bakery", P04: "Bakery", P05: "Produce",
  P06: "Dairy alternatives", P07: "Dairy alternatives", P08: "Dairy", P09: "Dairy alternatives", P10: "Dairy",
  P11: "Dairy", P12: "Dairy", P13: "Pantry", P14: "Pantry", P15: "Pantry", P16: "Pantry",
  P17: "Breakfast", P18: "Breakfast", P19: "Household", P20: "Household", P21: "Snacks", P22: "Snacks",
};

export const DEMO_PRODUCTS: Product[] = P.map((p) => ({
  id: p.id,
  storeId: DEMO_STORE.id,
  name: p.name,
  brand: p.brand,
  variant: p.variant,
  size: p.size,
  aliases: p.aliases,
  category: CATEGORY_BY_ID[p.id] ?? null,
  version: 1,
}));

export const DEMO_LOCATIONS: ProductLocation[] = P.map((p) => ({
  productId: p.id,
  shelfId: p.shelfId,
  level: p.level,
  verifiedAt: SEED_VERIFIED_AT,
  verifiedBy: "Seed data",
}));
