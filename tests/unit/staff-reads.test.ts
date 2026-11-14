import { describe, expect, it } from "vitest";
import { auditFromRow, displayOf, observationFromRow, parseStatuses } from "@/lib/staff/reads";

describe("staff read mappers (Supabase rows → screen types)", () => {
  it("maps audit actions to Activity kinds with readable summaries", () => {
    const e = auditFromRow({
      id: 42, actor_label: "dana@example.com", action: "observation.reject", entity: "observation", entity_id: "OBS-7",
      old_json: { status: "NEEDS_REVIEW" }, new_json: { status: "REJECTED", reason: "wrong item" }, created_at: "2026-11-14T10:00:00Z",
    });
    expect(e).toMatchObject({
      id: "42", action: "reject", summary: "OBS-7 rejected", evidence: "wrong item", original_observation: "OBS-7",
      old_json: { display: "status: NEEDS_REVIEW" }, new_json: { display: "status: REJECTED · reason: wrong item" },
    });
    const map = auditFromRow({ id: 1, actor_label: null, action: "map.publish", entity: "store_map", entity_id: "m2", old_json: { version: 1 }, new_json: { version: 2, shelves: 12 }, created_at: "x" });
    expect(map).toMatchObject({ action: "map", summary: "Floor plan v2 published", actor_label: "system", evidence: "—", original_observation: null });
    expect(auditFromRow({ ...map, action: "something.new", entity_id: null, new_json: null }).action).toBe("ai");
  });

  it("keeps a display string the writer set, and copes with empty json", () => {
    expect(displayOf({ display: "Aisle 2", shelf_id: "S-A2-1" })).toBe("Aisle 2");
    expect(displayOf(null)).toBe("—");
    expect(displayOf({ nested: { a: 1 } })).toBe("—");
  });

  it("maps observation rows, filling missing candidate fields and rejecting unknown levels", () => {
    const o = observationFromRow({
      id: "OBS-9", store_id: "demo-store", source: "ai", candidate_json: { name: "Oat milk", level: "sky" as never }, review_status: "NEEDS_REVIEW",
      version: 3, sightings: null, evidence: null, confidence: null, reviewed_by: null, reviewed_at: null, product_id: null, review_reason: null,
      created_at: "2026-11-14T10:00:00Z",
    });
    expect(o).toEqual({
      id: "OBS-9", source: "ai", storeId: "demo-store", at: "2026-11-14T10:00:00Z", confidence: "Medium", evidence: "", sightings: 1,
      candidate: { name: "Oat milk", brand: "", category: "", size: "", variant: "", aisle: "", shelf: "", level: "" },
      status: "NEEDS_REVIEW", version: 3,
    });
  });

  it("parses status filters", () => {
    expect(parseStatuses(null)).toBeNull();
    expect(parseStatuses("needs_review, NEEDS_RESCAN")).toEqual(["NEEDS_REVIEW", "NEEDS_RESCAN"]);
    expect(() => parseStatuses("DONE")).toThrow(/Unknown status DONE/);
  });
});
