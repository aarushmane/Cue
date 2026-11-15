import { beforeEach, describe, expect, it } from "vitest";
import { cloneMap, demoFloorPlan, mapChecks, reachable, routeTo, toStoreGraph } from "@/lib/map/graph";
import { findMatches } from "@/lib/review/matches";
import { draftFromObservation, validate } from "@/lib/review/validate";
import { db, moveProduct, publishMap, resetDemo, reviewObservation, saveMapDraft, submitShopperObservation } from "@/lib/db/demoState";
import { DEMO_STAFF, DEMO_RECOGNITION } from "@/lib/seed/demo-review";
import { getRepo } from "@/lib/db/repo";
import { resolveProduct } from "@/lib/search/matchProducts";
import type { ReviewDraft } from "@/lib/types";

const obs = (id: string) => db().observations.find((o) => o.id === id)!;
const ready = (id: string, patch: Partial<ReviewDraft> = {}): ReviewDraft => ({ ...draftFromObservation(obs(id)), idOk: true, locOk: true, ...patch });

beforeEach(() => resetDemo());

describe("findMatches", () => {
  it("surfaces Oatly P09 for OBS-104 but never auto-selects it", () => {
    const o = obs("OBS-104");
    const m = findMatches(o.candidate, db().products, o.suggestedMatch);
    expect(m.map((p) => p.id)).toContain("P09");
    expect(draftFromObservation(o).match).toBe("");
  });
  it("finds nothing for an unidentified observation", () => {
    expect(findMatches(obs("OBS-102").candidate, db().products)).toEqual([]);
  });
});

describe("validate", () => {
  it("blocks publishing until identity, inventory check and location are verified", () => {
    const o = obs("OBS-104");
    const fails = validate(o, draftFromObservation(o), db().products, db().maps.published).filter((c) => !c.ok).map((c) => c.k);
    expect(fails).toEqual(["id", "match", "loc"]);
  });
  it("flags missing size for Jif (OBS-101) and the invalid location for OBS-102", () => {
    const jif = validate(obs("OBS-101"), ready("OBS-101", { match: "new" }), db().products, db().maps.published);
    expect(jif.find((c) => c.k === "info")).toMatchObject({ ok: false, fix: "Missing: size or variant." });
    const unknown = validate(obs("OBS-102"), ready("OBS-102"), db().products, db().maps.published);
    expect(unknown.find((c) => c.k === "shelf")?.ok).toBe(false);
    expect(unknown.find((c) => c.k === "nav")?.ok).toBe(false);
  });
  it("requires the shelf to be placed on the published floor plan", () => {
    const map = cloneMap(db().maps.published);
    map.shelves = map.shelves.filter((s) => s.id !== "S-A2-2");
    const nav = validate(obs("OBS-104"), ready("OBS-104", { match: "P09", targetVersion: 1 }), db().products, map).find((c) => c.k === "nav")!;
    expect(nav).toMatchObject({ ok: false, fix: "S-A2-2 is not placed on published floor plan v1." });
  });
});

describe("reviewObservation (server contract for POST /api/observations/:id/review)", () => {
  it("merge → publish updates P09, removes it from pending, writes audit, and search still finds it", async () => {
    const before = db().audit.length;
    const r = reviewObservation({ action: "publish", observationId: "OBS-104", obsVersion: 1, draft: ready("OBS-104", { match: "P09", targetVersion: 1 }), targetVersion: 1 }, DEMO_STAFF);
    expect(r.ok).toBe(true);
    expect(obs("OBS-104").status).toBe("ACCEPTED"); // no field differs from the candidate
    const p9 = db().products.find((p) => p.id === "P09")!;
    expect(p9.version).toBe(2);
    expect(p9.aliases).toContain("oatmilk");
    expect(db().audit.length).toBe(before + 1);
    expect(db().audit[0]).toMatchObject({ action: "approve", entity_id: "P09" });
    const res = resolveProduct("oat milk", await getRepo().listPublishedProducts("demo-store"));
    expect(res.status).toBe("MATCH");
  });

  it("marks the observation EDITED when the employee corrected a field", () => {
    const r = reviewObservation({ action: "publish", observationId: "OBS-104", obsVersion: 1, draft: ready("OBS-104", { name: "Oat Milk", match: "P09", targetVersion: 1 }), targetVersion: 1 }, DEMO_STAFF);
    expect(r.ok).toBe(true);
    expect(obs("OBS-104").status).toBe("EDITED");
  });

  it("publishing a genuinely new product (OBS-105) adds it to published inventory", async () => {
    const r = reviewObservation({ action: "publish", observationId: "OBS-105", obsVersion: 1, draft: ready("OBS-105", { match: "new" }) }, DEMO_STAFF);
    expect(r.ok && r.isNew).toBe(true);
    expect(obs("OBS-105").status).toBe("ACCEPTED");
    const published = await getRepo().listPublishedProducts("demo-store");
    expect(published.some((p) => p.name === "Oat Milk Barista Blend" && p.location.shelfId === "S-A2-2")).toBe(true);
  });

  it("re-runs validate() on the server and returns 422 with failing labels", () => {
    const r = reviewObservation({ action: "publish", observationId: "OBS-101", obsVersion: 1, draft: ready("OBS-101", { match: "new" }) }, DEMO_STAFF);
    expect(r).toMatchObject({ ok: false, status: 422, code: "INVALID" });
    expect(obs("OBS-101").status).toBe("NEEDS_REVIEW");
  });

  it("reject and rescan require a reason and never touch inventory", () => {
    const products = JSON.stringify(db().products);
    expect(reviewObservation({ action: "reject", observationId: "OBS-102", obsVersion: 1, reason: "no" }, DEMO_STAFF)).toMatchObject({ ok: false, status: 422 });
    expect(reviewObservation({ action: "rescan", observationId: "OBS-102", obsVersion: 1, reason: "Product label turned away" }, DEMO_STAFF).ok).toBe(true);
    expect(obs("OBS-102")).toMatchObject({ status: "NEEDS_RESCAN", reason: "Product label turned away" });
    expect(reviewObservation({ action: "reject", observationId: "OBS-101", obsVersion: 1, reason: "Not sold in this store" }, DEMO_STAFF).ok).toBe(true);
    expect(obs("OBS-101").status).toBe("REJECTED");
    expect(JSON.stringify(db().products)).toBe(products);
  });

  it("returns 409 when another employee already approved (OBS-103) and on repeated approval", () => {
    const r = reviewObservation({ action: "publish", observationId: "OBS-103", obsVersion: 1, draft: ready("OBS-103", { match: "P11", targetVersion: 1 }), targetVersion: 1 }, DEMO_STAFF);
    expect(r).toMatchObject({ ok: false, status: 409, code: "ALREADY_REVIEWED" });
    expect(obs("OBS-103")).toMatchObject({ status: "ACCEPTED", reviewedBy: "Marcus T., Staff" });

    const req = { action: "publish" as const, observationId: "OBS-105", obsVersion: 1, draft: ready("OBS-105", { match: "new" }) };
    expect(reviewObservation(req, DEMO_STAFF).ok).toBe(true);
    expect(reviewObservation(req, DEMO_STAFF)).toMatchObject({ ok: false, status: 409, code: "ALREADY_REVIEWED" });
  });

  it("returns 409 when the merge target changed after it was selected", () => {
    expect(moveProduct("P09", "S-A2-1", "upper", 1, DEMO_STAFF).ok).toBe(true); // P09 → v2
    const r = reviewObservation({ action: "publish", observationId: "OBS-104", obsVersion: 1, draft: ready("OBS-104", { match: "P09", targetVersion: 1 }), targetVersion: 1 }, DEMO_STAFF);
    expect(r).toMatchObject({ ok: false, status: 409, code: "TARGET_CONFLICT" });
  });

  it("refuses staff without access to the store (403)", () => {
    const r = reviewObservation({ action: "reject", observationId: "OBS-102", obsVersion: 1, reason: "Wrong product" }, { ...DEMO_STAFF, stores: [] });
    expect(r).toMatchObject({ ok: false, status: 403 });
  });
});

describe("shopper observations", () => {
  it("a new sighting creates NEEDS_REVIEW; the same brand+name+shelf adds a sighting instead of a duplicate", () => {
    const skyr = DEMO_RECOGNITION[0];
    const a = submitShopperObservation({ storeId: "demo-store", confidence: skyr.confidence, evidence: skyr.evidence, candidate: skyr.candidate });
    expect(a.ok && !a.merged).toBe(true);
    const califia = DEMO_RECOGNITION[1];
    const b = submitShopperObservation({ storeId: "demo-store", confidence: califia.confidence, evidence: califia.evidence, candidate: califia.candidate });
    expect(b.ok && b.merged && b.observation.id).toBe("OBS-105");
    expect(obs("OBS-105").sightings).toBe(2);
  });

  it("consent → submit → approve → the product is on the published shelf and found by 'skyr'", async () => {
    const skyr = DEMO_RECOGNITION[0];
    const s = submitShopperObservation({ storeId: "demo-store", confidence: skyr.confidence, evidence: skyr.evidence, candidate: skyr.candidate });
    if (!s.ok) throw new Error(s.error);
    const id = s.observation.id;
    // The scan did not detect a level; the employee must pick one.
    expect(validate(obs(id), ready(id, { match: "new" }), db().products, db().maps.published).find((c) => c.k === "shelf")?.ok).toBe(false);
    const r = reviewObservation({ action: "publish", observationId: id, obsVersion: 1, draft: ready(id, { match: "new", level: "middle" }) }, DEMO_STAFF);
    expect(r.ok).toBe(true);
    const res = resolveProduct("skyr", await getRepo().listPublishedProducts("demo-store"));
    expect(res.status === "MATCH" && res.product.location.shelfId).toBe("S-A2-3");
  });
});

describe("floor plan graph", () => {
  it("the seeded map passes every publish check and every shelf is reachable", () => {
    const m = demoFloorPlan();
    expect(mapChecks(m, db().products).every((c) => c.ok)).toBe(true);
    expect(m.shelves.every((s) => reachable(m).has(s.anchor))).toBe(true);
    expect(routeTo(m, "N13")).toEqual(["N01", "N02", "N03", "N12", "N13"]);
  });

  it("a blank uploaded plan fails the checklist, including shelves that hold verified products", () => {
    const blank = { ...demoFloorPlan(), plan: { url: "blob:x", name: "plan.png", kind: "image" as const }, nodes: [], edges: [], shelves: [], landmarks: [] };
    const fails = mapChecks(blank, db().products).filter((c) => !c.ok).map((c) => c.label);
    expect(fails).toContain("At least one entrance labeled");
    expect(fails).toContain("Every shelf with verified products is placed");
  });

  it("publishing a draft bumps the version and routes use the new graph", async () => {
    const d = cloneMap(db().maps.published);
    d.landmarks[0].label = "Front doors";
    expect(saveMapDraft(d.mapId, d, DEMO_STAFF).ok).toBe(true);
    const r = publishMap(d.mapId, DEMO_STAFF);
    expect(r.ok && r.maps.published.version).toBe(2);
    const g = await getRepo().getPublishedGraph("demo-store");
    expect(g?.mapVersion).toBe(2);
    expect(toStoreGraph(db().maps.published, "demo-store").shelves).toHaveLength(12);
  });
});
