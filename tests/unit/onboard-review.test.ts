// Onboarding agent product suggestions → staff Review queue. They must arrive as NEEDS_REVIEW with no shelf, and
// never publish on their own.
import { beforeEach, describe, expect, it, vi } from "vitest";

const supa = vi.hoisted(() => ({ db: null as null | { from: (t: string) => unknown }, inserted: [] as { table: string; rows: unknown[] }[] }));
vi.mock("@/lib/db/admin", () => ({ getAdminDb: () => supa.db }));

import { addAiObservations, db, resetDemo, reviewObservation, type AiCandidate } from "@/lib/db/demoState";
import { queueAiObservations } from "@/lib/db/writes";
import { draftFromObservation, validate } from "@/lib/review/validate";
import { DEMO_STAFF } from "@/lib/seed/demo-review";
import { newRun } from "@/lib/agents/onboarding/run-context";
import { onboardingTools } from "@/lib/agents/onboarding/tools";
import { sweepsToGraph } from "@/lib/twin/sweepsToGraph";
import type { DataLayers } from "@/lib/costar";
import type { ReviewDraft } from "@/lib/types";

const cands: AiCandidate[] = [
  { name: "Oat Milk", brand: "Oatly", variant: "original", size: "64 oz", evidence: "OATLY logo, 64 FL OZ", confidence: "high", image_url: "https://x/p1.jpg" },
  { name: "Peanut Butter", brand: null, variant: null, size: null, evidence: "jar shape only", confidence: "low", image_url: "https://x/p1.jpg" },
  { name: "Granola", brand: "Bear Naked", variant: null, size: null, evidence: "", confidence: "medium" },
];
const obs = (id: string) => db().observations.find((o) => o.id === id)!;

beforeEach(() => {
  resetDemo();
  supa.db = null;
  supa.inserted = [];
});

describe("addAiObservations", () => {
  it("creates NEEDS_REVIEW ai observations with the next OBS ids, mapped confidence and no location", () => {
    const products = db().products.length;
    const r = addAiObservations("demo-store", cands, "Onboarding run r1.");
    if (!r.ok) throw new Error(r.error);
    expect(r.observations.map((o) => o.id)).toEqual(["OBS-106", "OBS-107", "OBS-108"]);
    expect(r.observations.map((o) => o.confidence)).toEqual(["High", "Low", "Medium"]);
    for (const o of r.observations) {
      expect(o).toMatchObject({ source: "ai", storeId: "demo-store", status: "NEEDS_REVIEW", version: 1 });
      expect(o.candidate).toMatchObject({ aisle: "", shelf: "", level: "", category: "" });
    }
    expect(r.observations[1].candidate).toEqual({ name: "Peanut Butter", brand: "", category: "", size: "", variant: "", aisle: "", shelf: "", level: "" });
    expect(r.observations[0].evidence).toBe("Onboarding run r1. Image: https://x/p1.jpg. Seen: OATLY logo, 64 FL OZ");
    // Visible in the Review queue's data, and nothing was published.
    expect(obs("OBS-107").status).toBe("NEEDS_REVIEW");
    expect(db().products).toHaveLength(products);
  });

  it("writes exactly one audit event", () => {
    const before = db().audit.length;
    const r = addAiObservations("demo-store", cands, "Onboarding run r1.");
    expect(db().audit).toHaveLength(before + 1);
    expect(db().audit[0]).toMatchObject({ action: "ai", entity: "observation", summary: "Onboarding agent queued 3 suggestions" });
    expect(r.ok && r.event?.new_json.observation_ids).toEqual(["OBS-106", "OBS-107", "OBS-108"]);
  });

  it("continues numbering after shopper submissions and skips nameless candidates", () => {
    addAiObservations("demo-store", [cands[0]], "");
    const r = addAiObservations("demo-store", [{ ...cands[1], name: "  " }, cands[2]], "");
    expect(r.ok && r.observations.map((o) => o.id)).toEqual(["OBS-107"]);
    expect(db().audit[0].summary).toBe("Onboarding agent queued 1 suggestion");
  });

  it("does nothing (no audit) for an empty list, and refuses an unknown store", () => {
    const before = db().audit.length;
    expect(addAiObservations("demo-store", [], "x")).toEqual({ ok: true, observations: [], event: null });
    expect(db().audit).toHaveLength(before);
    expect(addAiObservations("other-store", cands, "x")).toMatchObject({ ok: false, status: 404 });
  });
});

describe("reviewing an onboarding suggestion", () => {
  const add = () => {
    const r = addAiObservations("demo-store", [cands[0]], "Onboarding run r1.");
    if (!r.ok) throw new Error(r.error);
    return r.observations[0].id;
  };
  const ready = (id: string, patch: Partial<ReviewDraft> = {}): ReviewDraft => ({ ...draftFromObservation(obs(id)), idOk: true, locOk: true, match: "new", category: "Dairy alternatives", ...patch });

  it("blocks publish until a shelf is chosen, with a clear message", () => {
    const id = add();
    const checks = validate(obs(id), ready(id), db().products, db().maps.published);
    const shelf = checks.find((c) => c.k === "shelf")!;
    expect(shelf.ok).toBe(false);
    expect(shelf.fix).toMatch(/^No shelf chosen yet\./);
    expect(checks.find((c) => c.k === "store")).toMatchObject({ ok: false, fix: "Select a shelf first." });
    expect(checks.find((c) => c.k === "nav")).toMatchObject({ ok: false, fix: "Select a shelf first." });

    // Aisle picked, shelf still empty.
    expect(validate(obs(id), ready(id, { aisle: "2" }), db().products, db().maps.published).find((c) => c.k === "shelf")?.fix).toBe("No shelf chosen yet. Select a shelf section in Aisle 2.");

    const before = db().products.length;
    const r = reviewObservation({ action: "publish", observationId: id, obsVersion: 1, draft: ready(id) }, DEMO_STAFF);
    expect(r).toMatchObject({ ok: false, status: 422, code: "INVALID" });
    expect(db().products).toHaveLength(before);
    expect(obs(id).status).toBe("NEEDS_REVIEW");
  });

  it("publishes once staff choose category, shelf and level", () => {
    const id = add();
    const r = reviewObservation({ action: "publish", observationId: id, obsVersion: 1, draft: ready(id, { aisle: "2", shelf: "S-A2-2", level: "middle" }) }, DEMO_STAFF);
    expect(r.ok).toBe(true);
    expect(obs(id).status).toBe("EDITED");
  });
});

describe("queueAiObservations", () => {
  it("memory mode: goes to the demo backend", async () => {
    expect(await queueAiObservations("demo-store", cands, "e")).toEqual({ ids: ["OBS-106", "OBS-107", "OBS-108"] });
  });

  it("Supabase mode: inserts NEEDS_REVIEW ai rows matching migration 004", async () => {
    supa.db = {
      from: (table: string) => ({
        insert: (rows: unknown[]) => {
          supa.inserted.push({ table, rows });
          return { select: async () => ({ data: rows.map((_, i) => ({ id: `uuid-${i}` })), error: null }) };
        },
      }),
    };
    expect(await queueAiObservations("store-9", cands, "Run r1.")).toEqual({ ids: ["uuid-0", "uuid-1", "uuid-2"] });
    expect(supa.inserted).toHaveLength(1);
    expect(supa.inserted[0].table).toBe("observations");
    expect(supa.inserted[0].rows[0]).toEqual({
      store_id: "store-9", media_id: null, source: "ai", review_status: "NEEDS_REVIEW", confidence: "High",
      evidence: "Run r1. Image: https://x/p1.jpg. Seen: OATLY logo, 64 FL OZ",
      candidate_json: { name: "Oat Milk", brand: "Oatly", category: "", size: "64 oz", variant: "original", aisle: "", shelf: "", level: "" },
    });
    // Nothing touched the in-memory queue.
    expect(db().observations.some((o) => o.id === "OBS-106")).toBe(false);
  });

  it("Supabase mode: surfaces insert errors", async () => {
    supa.db = { from: () => ({ insert: () => ({ select: async () => ({ data: null, error: { message: "column \"source\" does not exist" } }) }) }) };
    await expect(queueAiObservations("store-9", cands, "e")).rejects.toThrow(/source/);
  });
});

describe("save_draft tool", () => {
  const sweeps = [
    { id: "a", x: 0, y: 0, floorId: "f", neighbors: ["b"] },
    { id: "b", x: 5, y: 0, floorId: "f", neighbors: ["a"] },
  ];
  const setup = (storeId?: string) => {
    const run = newRun("run-t", { source: "fixture" } as DataLayers, storeId);
    run.graph = sweepsToGraph(sweeps, { floorId: "f", entranceSweepId: "a" });
    run.candidates = cands.map((c) => ({ ...c, image_url: c.image_url ?? "https://x/p2.jpg", review_status: "NEEDS_REVIEW" as const }));
    const save = onboardingTools(run).main.find((t) => t.name === "save_draft")!;
    return { run, save: () => save.invoke({}) };
  };

  it("defaults to demo-store, queues suggestions once, and publishes nothing", async () => {
    const products = db().products.length;
    const { run, save } = setup();
    expect(run.storeId).toBe("demo-store");
    const out = JSON.parse(String(await save()));
    expect(out.product_suggestions).toMatch(/^3 queued in Review as NEEDS_REVIEW/);
    expect(run.observationIds).toEqual(["OBS-106", "OBS-107", "OBS-108"]);
    expect(obs("OBS-106")).toMatchObject({ source: "ai", status: "NEEDS_REVIEW" });
    expect(obs("OBS-106").evidence).toContain("Onboarding agent run run-t");
    // Calling save_draft again doesn't duplicate them.
    await save();
    expect(db().observations.filter((o) => o.source === "ai" && o.evidence.includes("run-t"))).toHaveLength(3);
    expect(db().products).toHaveLength(products);
  });

  it("keeps the draft and reports the problem when queueing fails", async () => {
    const { run, save } = setup("unknown-store");
    const out = JSON.parse(String(await save()));
    expect(out.draft_id).toBeTruthy();
    expect(out.product_suggestions).toMatch(/^Could not add suggestions to the Review queue: Unknown store\./);
    expect(run.observationIds).toEqual([]);
  });
});
