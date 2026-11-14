// Shopper sightings (adaptive inventory) share one in-memory store with staff review, Inventory and shopper search.
import { beforeEach, describe, expect, it } from "vitest";
import { applyScan } from "@/lib/inventory/store";
import { listSightingsDemo, reviewSightingDemo } from "@/lib/demo/sightings";
import { db, resetDemo } from "@/lib/db/demoState";
import { getRepo } from "@/lib/db/repo";

const STORE = "demo-store";
const proposed = { name: "Oat Crunch Bars", brand: "Trailside", variant: null, size: "6 ct", category: "Snacks" };

describe("shopper sightings", () => {
  beforeEach(() => resetDemo());

  it("approving a new-item sighting publishes it to shopper search and logs Activity", async () => {
    await applyScan(STORE, {
      confirmed: [],
      deltas: [{ kind: "NEW_PRODUCT", key: "new|trailside oat crunch bars", product_id: null, proposed, shelf_ids: ["S-A4-1"], evidence: "Box on middle shelf" }],
    });
    const listed = await listSightingsDemo();
    if (!listed.ok) throw new Error(listed.error);
    const s = listed.sightings.queue.find((q) => q.proposed.name === proposed.name)!;
    expect(s).toBeTruthy();

    const r = await reviewSightingDemo({ id: s.id, action: "approve", shelfId: "S-A4-1", level: "middle" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sightings.queue.some((q) => q.id === s.id)).toBe(false);

    const published = await getRepo().listPublishedProducts(STORE);
    const p = published.find((x) => x.name === proposed.name)!;
    expect(p.shelf.id).toBe("S-A4-1");
    expect(p.id).toMatch(/^P\d{2,}$/); // same id scheme as staff review
    expect(db().audit[0].summary).toMatch(/Shopper sighting approved: Trailside Oat Crunch Bars 6 ct/);
  });

  it("rejects malformed input without changing anything", async () => {
    const before = db().products.length;
    const r = await reviewSightingDemo({ id: "", action: "approve" });
    expect(r.ok).toBe(false);
    expect(db().products.length).toBe(before);
  });
});
