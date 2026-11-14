// Exercises the shopper agent's tools directly (no model calls) against the in-memory demo store.
import { describe, expect, it } from "vitest";
import { ShopperNav } from "@/lib/agents/shopper/state";
import { runShopperTool, type ToolContext } from "@/lib/agents/shopper/tools";
import { memoryMoveProduct } from "@/lib/db/repo";

function ctx(overrides: Partial<ShopperNav> = {}): ToolContext {
  return { nav: ShopperNav.parse({ store_id: "demo-store", ...overrides }), spoken: [], choices: [], reports: [] };
}

describe("shopper tools", () => {
  it("asks for a choice on ambiguous products and never auto-selects", async () => {
    const c = ctx();
    const r = await runShopperTool("search_products", { query: "almond milk" }, c);
    expect(r.status).toBe("AMBIGUOUS");
    expect(c.choices).toHaveLength(2);
    expect(c.nav.product_id).toBeNull();
  });

  it("refuses to route without a position (no fabricated guidance)", async () => {
    const c = ctx();
    await runShopperTool("select_product", { product_id: "P06" }, c);
    const r = await runShopperTool("start_route", {}, c);
    expect(r.error).toBe("POSITION_UNKNOWN");
    expect(c.spoken).toHaveLength(0);
    expect(c.nav.state).toBe("LOCATING");
  });

  it("rejects products that are not in published inventory", async () => {
    const r = await runShopperTool("select_product", { product_id: "P999" }, ctx());
    expect(r.error).toBeDefined();
  });

  it("guides step by step with verbatim route text, then arrives", async () => {
    const c = ctx({ current_node_id: "N01", position_confidence: "CONFIRMED" });
    await runShopperTool("select_product", { product_id: "P10" }, c);
    await runShopperTool("start_route", {}, c);
    expect(c.nav.state).toBe("GUIDING");
    expect(c.spoken[0]).toMatch(/^Head toward/);
    await runShopperTool("repeat_step", {}, c);
    expect(c.spoken[1]).toBe(c.spoken[0]);
    let guard = 0;
    while (c.nav.state !== "ARRIVED" && guard++ < 10) await runShopperTool("next_step", {}, c);
    expect(c.spoken.at(-1)).toMatch(/^You have reached Aisle 2, section 2\. Large Eggs/);
  });

  it("reroutes mid-guidance when staff move the product (dynamic update)", async () => {
    const c = ctx({ current_node_id: "N01", position_confidence: "CONFIRMED" });
    await runShopperTool("select_product", { product_id: "P21" }, c); // chips, Aisle 4 section 2
    await runShopperTool("start_route", {}, c);
    expect(c.nav.destination_shelf_id).toBe("S-A4-2");

    expect(memoryMoveProduct("P21", "S-A1-3", "middle")).toBe(true);
    try {
      const r = await runShopperTool("next_step", {}, c);
      expect(r.rerouted).toBe(true);
      expect(c.nav.destination_shelf_id).toBe("S-A1-3");
      expect(c.spoken).toContain("The store just updated where this item is. Rerouting.");
    } finally {
      memoryMoveProduct("P21", "S-A4-2", "middle");
    }
  });

  it("adapts preferences and files reports without touching inventory", async () => {
    const c = ctx();
    await runShopperTool("set_preferences", { verbosity: "detailed", speech_rate: 3 }, c);
    expect(c.nav.prefs).toEqual({ verbosity: "detailed", speech_rate: 2 });
    await runShopperTool("report_issue", { note: "Shelf is empty" }, c);
    expect(c.reports).toEqual([{ product_id: null, note: "Shelf is empty" }]);
  });
});
