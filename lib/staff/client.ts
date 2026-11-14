// Manager-app calls to the staff API routes (docs/contracts.md), through staffFetch so Supabase mode sends the
// signed-in employee's token. Results use the screens' { ok, status, code, error, failing } shape.
// The routes don't return a fresh StaffSnapshot: callers refresh it (useStaff().refresh) after each write.
// Client-only.
import { callJson, jsonInit, type ApiResult } from "../api/client";
import { staffFetch } from "../auth/staffFetch";
import type { FloorPlan, ReviewAction, ReviewDraft, ShelfLevel } from "../types";

const seg = encodeURIComponent;

export interface ReviewOk { observation_id: string; status: string; product_id: string | null; is_new: boolean }

/** POST /api/observations/:id/review */
export const reviewObservation = (
  id: string,
  body: { action: ReviewAction; obs_version: number; draft?: ReviewDraft; target_version?: number | null; reason?: string },
): Promise<ApiResult<ReviewOk>> => callJson(staffFetch(`/api/observations/${seg(id)}/review`, jsonInit("POST", body)));

/** PATCH /api/products/:id/location */
export const moveProduct = (id: string, shelfId: string, level: ShelfLevel, expectedVersion: number) =>
  callJson<{ version: number }>(
    staffFetch(`/api/products/${seg(id)}/location`, jsonInit("PATCH", { shelf_id: shelfId, level, expected_version: expectedVersion })),
  );

/** PUT /api/maps/:id/graph: save the editor's draft (never published by this call). */
export const saveMapDraft = (mapId: string, draft: FloorPlan) =>
  callJson<object>(staffFetch(`/api/maps/${seg(mapId)}/graph`, jsonInit("PUT", draft)));

/** PUT the draft, then POST /api/maps/:id/publish (the server re-runs the publish checklist). */
export async function publishMap(mapId: string, draft: FloorPlan): Promise<ApiResult<{ version: number }>> {
  const saved = await saveMapDraft(mapId, draft);
  if (!saved.ok) return saved;
  return callJson<{ version: number }>(staffFetch(`/api/maps/${seg(mapId)}/publish`, jsonInit("POST")));
}
