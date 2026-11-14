import { describe, expect, it } from "vitest";
import { getRepo } from "@/lib/db/repo";
import { matchSighting, planScan, shelvesInView, type Sighting } from "@/lib/inventory/reconcile";
import { applyScan, listInventory, listSuggestions, reviewSuggestion } from "@/lib/inventory/store";

const STORE = "demo-store";
const seen = (name: string, brand: string | null, size: string | null, extra: Partial<Sighting> = {}): Sighting => ({
  name, brand, variant: null, size, category: null, evidence: `${brand ?? ""} ${name} label`, confidence: "high", ...extra,
});
const staff = { userId: null, label: "test-staff" };

async function ctx() {
  const repo = getRepo();
  return { graph: (await repo.getPublishedGraph(STORE))!, products: await repo.listPublishedProducts(STORE) };
}

describe("reconcile (pure)", () => {
  it("knows which shelves are in view", async () => {
    const { graph } = await ctx();
    expect(shelvesInView(graph, "N12")).toEqual({ ids: ["S-A2-1"], direct: true });
    expect(shelvesInView(graph, "N15").ids.sort()).toEqual(["S-A3-1", "S-A4-1"]);
    expect(shelvesInView(graph, "N03").direct).toBe(false);
  });

  it("matches by name + brand + size, and treats a different size as a different product", async () => {
    const { products } = await ctx();
    expect(matchSighting(seen("Almond Milk", "Silk", "64 oz"), products)).toMatchObject({ kind: "match", product: { id: "P06" } });
    expect(matchSighting(seen("Almond Milk", null, null), products).kind).toBe("ambiguous"); // Silk or Almond Breeze
    expect(matchSighting(seen("Almond Milk", "Silk", "32 oz"), products).kind).toBe("none");
    expect(matchSighting(seen("Coconut Water", "Vita Coco", "16.9 fl oz"), products).kind).toBe("none");
  });

  it("handles what the live vision model actually returns (brand in name, punctuation, FL OZ)", async () => {
    const { products } = await ctx();
    // Verbatim from a Gemini scan of a synthetic shelf photo (Nov 14).
    expect(matchSighting(seen("Silk Unsweetened Almond Milk", "Silk", "64 FL OZ"), products)).toMatchObject({ kind: "match", product: { id: "P06" } });
    expect(matchSighting(seen("OATLY! Oat Milk Original", "OATLY!", "64 FL OZ"), products)).toMatchObject({ kind: "match", product: { id: "P09" } });
    expect(matchSighting(seen("Vita Coco Coconut Water", "Vita Coco", "16.9 FL OZ"), products).kind).toBe("none");
    expect(matchSighting(seen("Almond Breeze Almond Milk", "Almond Breeze", "32 FL OZ"), products)).toMatchObject({ kind: "match", product: { id: "P07" } });
  });

  it("dedups a new product the model names differently across scans", async () => {
    const { graph, products } = await ctx();
    const key = (n: string) => planScan({ graph, products, nodeId: "N12", sightings: [seen(n, "Vita Coco", "16.9 FL OZ")] }).deltas.find((d) => d.kind === "NEW_PRODUCT")!.key;
    expect(key("Vita Coco Coconut Water")).toBe(key("Coconut Water"));
  });

  it("plans confirmations, new items, moves and misses for a scan at Aisle 2 section 1", async () => {
    const { graph, products } = await ctx();
    const plan = planScan({
      graph, products, nodeId: "N12",
      sightings: [
        seen("Unsweetened Almond Milk", "Silk", "64 oz"),            // listed here → confirm
        seen("Oat Milk", "Oatly", "64 oz"),                           // listed on S-A2-2 → moved
        seen("Coconut Water", "Vita Coco", "16.9 fl oz"),             // not listed → new
        seen("Mystery Box", null, null, { confidence: "low" }),       // ignored
      ],
    });
    expect(plan.confirmed).toEqual(["P06"]);
    const kinds = Object.fromEntries(plan.deltas.map((d) => [d.key, d.kind]));
    expect(kinds["MOVED:P09"]).toBe("MOVED");
    expect(Object.values(kinds).filter((k) => k === "NEW_PRODUCT")).toHaveLength(1);
    // Shelf S-A2-1 was demonstrably in view, so its unseen listed items count as misses.
    expect(kinds["MISSING:P07"]).toBe("MISSING");
    expect(kinds["MISSING:P08"]).toBe("MISSING");
  });

  it("records nothing without a known shelf, and no misses from a walkway", async () => {
    const { graph, products } = await ctx();
    const plan = planScan({ graph, products, nodeId: "N03", sightings: [seen("Unsweetened Almond Milk", "Silk", "64 oz")] });
    expect(plan.deltas.filter((d) => d.kind === "MISSING")).toHaveLength(0);
    expect(plan.deltas.filter((d) => d.kind === "MOVED")).toHaveLength(0);
  });
});

describe("adaptive inventory (memory store)", () => {
  it("collects sightings, waits for staff approval, then adapts the published list", async () => {
    const scan = async (s: Sighting[], node = "N12") => {
      const { graph, products } = await ctx();
      await applyScan(STORE, planScan({ graph, products, nodeId: node, sightings: s }));
    };

    // 1. A new product: one sighting puts it in the queue, but it is NOT in the inventory yet.
    await scan([seen("Coconut Water", "Vita Coco", "16.9 fl oz", { category: "beverage" }), seen("Unsweetened Almond Milk", "Silk", "64 oz")]);
    const pending = await listSuggestions(STORE);
    const newItem = pending.find((s) => s.kind === "NEW_PRODUCT")!;
    expect(newItem.proposed).toMatchObject({ name: "Coconut Water", brand: "Vita Coco", category: "beverage" });
    expect((await listInventory(STORE)).some((i) => i.name === "Coconut Water")).toBe(false);
    expect((await listInventory(STORE)).find((i) => i.product_id === "P06")!.last_seen_at).not.toBeNull();

    // 2. Staff approve → it is now findable by shoppers, at the sighted shelf.
    const ok = await reviewSuggestion(newItem.id, "approve", { level: "middle" }, staff);
    expect(ok.ok).toBe(true);
    const added = (await getRepo().listPublishedProducts(STORE)).find((p) => p.name === "Coconut Water")!;
    expect(added).toMatchObject({ shelf: { id: "S-A2-1" }, location: { level: "middle" } });
    expect((await reviewSuggestion(newItem.id, "approve", {}, staff)).ok).toBe(false); // already decided

    // 3. A move needs 2 sightings before it reaches the queue.
    await scan([seen("Oat Milk", "Oatly", "64 oz")]);
    expect((await listSuggestions(STORE)).some((s) => s.kind === "MOVED")).toBe(false);
    expect((await listSuggestions(STORE, ["COLLECTING"])).some((s) => s.key === "MOVED:P09")).toBe(true);
    await scan([seen("Oat Milk", "Oatly", "64 oz")]);
    const moved = (await listSuggestions(STORE)).find((s) => s.key === "MOVED:P09")!;
    await reviewSuggestion(moved.id, "approve", {}, staff);
    expect((await getRepo().listPublishedProducts(STORE)).find((p) => p.id === "P09")!.shelf.id).toBe("S-A2-1");

    // 4. "Possibly gone" is auto-resolved when a shopper sees the item again.
    const missing = (await listSuggestions(STORE, ["COLLECTING", "PENDING"])).find((s) => s.key === "MISSING:P08");
    expect(missing).toBeDefined();
    await scan([seen("Whole Milk", "Horizon Organic", "half gallon")]);
    expect((await listSuggestions(STORE, ["AUTO_RESOLVED"])).some((s) => s.key === "MISSING:P08")).toBe(true);

    // 5. Rejecting changes nothing in the list.
    await scan([seen("Sparkling Water", "LaCroix", "12 pack")]);
    const fizz = (await listSuggestions(STORE)).find((s) => s.proposed.name === "Sparkling Water")!;
    await reviewSuggestion(fizz.id, "reject", { note: "display only" }, staff);
    expect((await listInventory(STORE)).some((i) => i.name === "Sparkling Water")).toBe(false);
  });
});
