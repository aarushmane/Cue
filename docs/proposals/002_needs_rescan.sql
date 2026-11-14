-- PROPOSED MIGRATION — NOT APPLIED. Review before copying into supabase/migrations/.
--
-- Adds NEEDS_RESCAN to the observation review status (v4 design handoff, docs/contracts.md).
--
-- Effects:
--   * observations.review_status accepts one more value, 'NEEDS_RESCAN'. Every existing row already satisfies the
--     new constraint, so no data changes and no rows are rewritten.
--   * Adds a nullable review_reason column (the required reason for reject / rescan). Existing rows get NULL.
--   * Nothing else changes: RLS policies, move_product(), product_locations and shopper reads are untouched.
--     Shopper search only reads PUBLISHED product_locations, so NEEDS_RESCAN observations stay invisible to shoppers.
--   * ALTER TABLE ... DROP/ADD CONSTRAINT takes a brief ACCESS EXCLUSIVE lock on observations while the new
--     constraint is validated against existing rows.
--
-- Open questions for the backend owner (deliberately NOT changed here):
--   * observations.media_id is NOT NULL, but consented shopper submissions are structured text only (no media).
--   * The v4 contract needs optimistic concurrency (observations.version), source ('shopper' | 'ai') and a
--     sightings count; none of these columns exist yet.
--
-- Rollback (only if no row uses NEEDS_RESCAN yet):
--   alter table observations drop constraint observations_review_status_check;
--   alter table observations add constraint observations_review_status_check
--     check (review_status in ('NEEDS_REVIEW', 'ACCEPTED', 'EDITED', 'REJECTED'));
--   alter table observations drop column review_reason;

begin;

-- 001_init.sql declares the check inline, so Postgres named it observations_review_status_check.
alter table observations drop constraint if exists observations_review_status_check;
alter table observations add constraint observations_review_status_check
  check (review_status in ('NEEDS_REVIEW', 'ACCEPTED', 'EDITED', 'REJECTED', 'NEEDS_RESCAN'));

alter table observations add column if not exists review_reason text
  check (review_reason is null or char_length(review_reason) >= 5);

commit;
