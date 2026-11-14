import { describe, expect, it } from "vitest";
import { normalize, resolveProduct } from "@/lib/search/matchProducts";
import { DEMO_PRODUCTS } from "@/lib/seed/demo-store";

describe("normalize", () => {
  it("strips filler phrases and punctuation", () => {
    expect(normalize("Where can I find the almond milk?")).toBe("almond milk");
    expect(normalize("I'm looking for Jif peanut-butter please")).toBe("jif peanut butter");
  });
});

describe("resolveProduct", () => {
  it("asks the shopper to choose between almond milk variants (ambiguous product)", () => {
    const r = resolveProduct("find almond milk", DEMO_PRODUCTS);
    expect(r.status).toBe("AMBIGUOUS");
    if (r.status === "AMBIGUOUS") expect(r.options.map((p) => p.id).sort()).toEqual(["P06", "P07"]);
  });

  it("resolves a brand-qualified request to one variant", () => {
    const r = resolveProduct("silk almond milk", DEMO_PRODUCTS);
    expect(r.status === "MATCH" && r.product.id).toBe("P06");
  });

  it("handles plurals and spoken phrasing", () => {
    expect(resolveProduct("where are the eggs", DEMO_PRODUCTS)).toMatchObject({ status: "MATCH", product: { id: "P10" } });
    expect(resolveProduct("bananas", DEMO_PRODUCTS)).toMatchObject({ status: "MATCH", product: { id: "P01" } });
    expect(resolveProduct("Oatly", DEMO_PRODUCTS)).toMatchObject({ status: "MATCH", product: { id: "P09" } });
  });

  it("returns NO_MATCH for unknown items", () => {
    expect(resolveProduct("motor oil", DEMO_PRODUCTS).status).toBe("NO_MATCH");
    expect(resolveProduct("", DEMO_PRODUCTS).status).toBe("NO_MATCH");
  });
});
