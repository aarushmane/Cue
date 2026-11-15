// Full review checklist in Supabase mode (issue #6, 4E): the same validate() the Review screen and memory mode run,
// fed from Supabase rows. Pure, so it is tested without a database.
import { validate, type ReviewCheck } from "../review/validate";
import type { FloorPlan, ReviewDraft, ReviewStatus } from "../types";

export interface ObservationRow { store_id: string; review_status: string }

/**
 * Failing checks for publishing `draft` from an observation row. `products` are the store's products with a
 * published location (merge targets), `published` is the store's published map in editor format (null if none).
 * Returns the failing checks only (empty = may publish).
 */
export function failingReviewChecks(
  row: ObservationRow, draft: ReviewDraft, products: { id: string }[], published: FloorPlan | null,
): ReviewCheck[] {
  return validate({ storeId: row.store_id, status: row.review_status as ReviewStatus }, draft, products, published).filter((c) => !c.ok);
}

/** The 422 body both backends return when the checklist fails. */
export const checklistFailure = (fails: ReviewCheck[]) => ({
  code: "INVALID",
  error: "Server validation failed: " + fails.map((f) => f.label.toLowerCase()).join("; ") + ".",
  failing: fails.map((f) => f.label),
});
