import { describe, expect, it } from "vitest";
import { demoFloorPlan } from "@/lib/map/graph";
import { tablesToFloorPlan } from "@/lib/staff/maps";
import { checklistFailure, failingReviewChecks } from "@/lib/staff/validateRows";
import type { ReviewDraft } from "@/lib/types";

// Supabase-shaped fixture: an observation row, product rows and a published map read back from its rows.
const obsRow = { store_id: "demo-store", review_status: "NEEDS_REVIEW" };
const products = [{ id: "P01" }, { id: "P02" }];
const seedMap = { ...demoFloorPlan(), mapId: "map-demo-v1" };

const draft = (over: Partial<ReviewDraft> = {}): ReviewDraft => ({
  name: "Califia Oat Milk", brand: "Califia", category: "Dairy alternatives", size: "48 oz", variant: "",
  aisle: "1", shelf: "S-A1-1", level: "middle", match: "new", targetVersion: null, idOk: true, locOk: true, obsVersion: 1, ...over,
});

describe("failingReviewChecks (Supabase mode)", () => {
  it("passes a complete review", () => {
    expect(failingReviewChecks(obsRow, draft(), products, seedMap)).toEqual([]);
  });

  it("needs a shelf for onboarding suggestions (no aisle or shelf yet)", () => {
    const f = failingReviewChecks(obsRow, draft({ aisle: "", shelf: "", level: "" }), products, seedMap);
    expect(f.map((c) => c.k)).toEqual(["shelf", "store", "nav"]);
    expect(f[0].fix).toMatch(/No shelf chosen yet/);
  });

  it("refuses an unknown merge target, a shelf in another aisle and missing confirmations", () => {
    const f = failingReviewChecks(obsRow, draft({ match: "P99", aisle: "2", idOk: false, locOk: false }), products, seedMap);
    expect(f.map((c) => c.k)).toEqual(["id", "match", "shelf", "loc"]);
    expect(checklistFailure(f)).toEqual({
      code: "INVALID",
      error: "Server validation failed: product identity verified; checked against existing inventory; exact aisle, shelf section and level selected; exact shelf location verified.",
      failing: ["Product identity verified", "Checked against existing inventory", "Exact aisle, shelf section and level selected", "Exact shelf location verified"],
    });
  });

  it("checks the shelf against the published map read from Supabase rows", () => {
    const published = tablesToFloorPlan({ id: "m2", version: 2 }, { width_m: 30, height_m: 20 }, {
      nodes: [{ id: "m2:N01", x: 0.1, y: 0.9, kind: "entrance" }], edges: [], shelves: [], landmarks: [],
    });
    const f = failingReviewChecks(obsRow, draft(), products, published);
    expect(f.map((c) => c.k)).toEqual(["nav"]);
    expect(f[0].fix).toBe("S-A1-1 is not placed on published floor plan v2.");
    expect(failingReviewChecks(obsRow, draft(), products, null).map((c) => c.k)).toEqual(["nav"]);
  });

  it("refuses an observation that was already processed and a shelf from another store", () => {
    expect(failingReviewChecks({ ...obsRow, review_status: "NEEDS_RESCAN" }, draft(), products, seedMap).map((c) => c.k)).toEqual(["status"]);
    expect(failingReviewChecks({ ...obsRow, store_id: "store-2" }, draft(), products, seedMap).map((c) => c.k)).toEqual(["store"]);
  });
});
