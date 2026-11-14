-- 004: v4 staff review (supersedes docs/proposals/002_needs_rescan.sql).
--
-- * observations: NEEDS_RESCAN status + review_reason; store_id (shopper submissions have no media, so the store
--   can't come from media); media_id becomes nullable; source ('ai' | 'shopper'); sightings; version for
--   optimistic concurrency.
-- * products: version for optimistic concurrency on merges and moves.
-- * review_observation(): the whole review in one transaction, in the contract's order:
--   still NEEDS_REVIEW (409) → observation version (409) → merge target version (409) → write.
--   Staff authorization (403) and validate() (422) run in the route before this is called.
-- * submit_shopper_observation(): text-only shopper submission; an identical pending one gains a sighting instead.
--
-- Every existing row satisfies the new constraints; nothing is rewritten except the store_id backfill.

begin;

-- ───────────────────────────── observations ─────────────────────────────
alter table observations drop constraint if exists observations_review_status_check;
alter table observations add constraint observations_review_status_check
  check (review_status in ('NEEDS_REVIEW', 'ACCEPTED', 'EDITED', 'REJECTED', 'NEEDS_RESCAN'));

alter table observations add column if not exists review_reason text
  check (review_reason is null or char_length(review_reason) >= 5);
alter table observations add column if not exists store_id text references stores(id) on delete cascade;
update observations o set store_id = m.store_id from media m where o.store_id is null and m.id = o.media_id;
alter table observations alter column store_id set not null;
alter table observations alter column media_id drop not null;
alter table observations add column if not exists source text not null default 'ai' check (source in ('ai', 'shopper'));
alter table observations add column if not exists sightings int not null default 1 check (sightings >= 1);
alter table observations add column if not exists version int not null default 1;
alter table observations add column if not exists evidence text;
alter table observations add column if not exists confidence text check (confidence is null or confidence in ('High', 'Medium', 'Low'));
create index if not exists observations_store_status on observations (store_id, review_status);

-- Staff read policy now uses the observation's own store.
drop policy if exists "staff read observations" on observations;
create policy "staff read observations" on observations for select using (is_store_staff(store_id));

-- ───────────────────────────── products ─────────────────────────────
alter table products add column if not exists version int not null default 1;

-- ───────────────────────────── review_observation ─────────────────────────────
-- p_action: 'publish' | 'reject' | 'rescan'.
-- publish: p_target_product_id null = new product from p_fields; otherwise merge into that product (p_target_version
-- must match). p_fields: { name, brand, variant, size, category }. p_edited marks EDITED vs ACCEPTED.
-- Returns { code: 'OK', observation_id, product_id?, status } or { code: 'ALREADY_REVIEWED' | 'CONFLICT' |
-- 'TARGET_CONFLICT' | 'NOT_FOUND' | 'INVALID', error }.
create or replace function review_observation(
  p_observation_id text, p_action text, p_obs_version int, p_actor uuid, p_actor_label text,
  p_reason text default null, p_fields jsonb default null, p_shelf_id text default null, p_level text default null,
  p_target_product_id text default null, p_target_version int default null, p_edited boolean default false
) returns jsonb language plpgsql as $$
declare o observations; t products; v_product text; v_status text; v_name text;
begin
  select * into o from observations where id = p_observation_id for update;
  if not found then return jsonb_build_object('code', 'NOT_FOUND', 'error', 'Observation not found.'); end if;
  if o.review_status <> 'NEEDS_REVIEW' then
    return jsonb_build_object('code', 'ALREADY_REVIEWED', 'error', format('This observation is already %s. It cannot be reviewed again.', lower(o.review_status)));
  end if;
  if o.version <> p_obs_version then
    return jsonb_build_object('code', 'CONFLICT', 'error', 'This observation changed since you opened it. Go back to the queue and review it again.');
  end if;

  if p_action in ('reject', 'rescan') then
    if p_reason is null or char_length(trim(p_reason)) < 5 then
      return jsonb_build_object('code', 'INVALID', 'error', 'A reason of at least 5 characters is required.');
    end if;
    v_status := case p_action when 'reject' then 'REJECTED' else 'NEEDS_RESCAN' end;
    update observations set review_status = v_status, review_reason = trim(p_reason), reviewed_by = p_actor,
      reviewed_at = now(), version = version + 1 where id = o.id;
    insert into audit_events (store_id, actor_id, actor_label, action, entity, entity_id, old_json, new_json)
    values (o.store_id, p_actor, p_actor_label, 'observation.' || p_action, 'observation', o.id,
            jsonb_build_object('status', 'NEEDS_REVIEW'), jsonb_build_object('status', v_status, 'reason', trim(p_reason)));
    return jsonb_build_object('code', 'OK', 'observation_id', o.id, 'status', v_status);
  end if;

  if p_action <> 'publish' then return jsonb_build_object('code', 'INVALID', 'error', 'Unknown action.'); end if;
  v_name := nullif(trim(coalesce(p_fields->>'name', '')), '');
  if v_name is null or p_shelf_id is null then
    return jsonb_build_object('code', 'INVALID', 'error', 'A product name and shelf are required to publish.');
  end if;

  if p_target_product_id is null then
    insert into products (store_id, name, brand, variant, size, category, aliases)
    values (o.store_id, v_name, nullif(trim(p_fields->>'brand'), ''), nullif(trim(p_fields->>'variant'), ''),
            nullif(trim(p_fields->>'size'), ''), nullif(trim(p_fields->>'category'), ''), array[lower(v_name)])
    returning id into v_product;
  else
    select * into t from products where id = p_target_product_id for update;
    if not found or t.store_id <> o.store_id then
      return jsonb_build_object('code', 'INVALID', 'error', 'The selected product is not in this store.');
    end if;
    if t.version <> p_target_version then
      return jsonb_build_object('code', 'TARGET_CONFLICT', 'error', format('%s was changed by another employee after you selected it. Review the current record and confirm again.', t.name));
    end if;
    update products set name = v_name, brand = nullif(trim(p_fields->>'brand'), ''), variant = nullif(trim(p_fields->>'variant'), ''),
      size = nullif(trim(p_fields->>'size'), ''), category = coalesce(nullif(trim(p_fields->>'category'), ''), category),
      aliases = (select array_agg(distinct a) from unnest(aliases || lower(v_name)) a), version = version + 1
     where id = t.id;
    v_product := t.id;
  end if;

  -- Location + its audit event (location.publish / location.move).
  perform move_product(v_product, p_shelf_id, p_level, p_actor, p_actor_label, o.id);

  v_status := case when p_edited then 'EDITED' else 'ACCEPTED' end;
  update observations set review_status = v_status, reviewed_by = p_actor, reviewed_at = now(), product_id = v_product,
    version = version + 1 where id = o.id;
  insert into audit_events (store_id, actor_id, actor_label, action, entity, entity_id, old_json, new_json)
  values (o.store_id, p_actor, p_actor_label, 'observation.approve', 'observation', o.id,
          jsonb_build_object('status', 'NEEDS_REVIEW'),
          jsonb_build_object('status', v_status, 'product_id', v_product, 'new_product', p_target_product_id is null));
  return jsonb_build_object('code', 'OK', 'observation_id', o.id, 'product_id', v_product, 'status', v_status);
end $$;

-- ───────────────────────────── submit_shopper_observation ─────────────────────────────
-- Structured text only (no media, no shopper identity). Same brand + name + shelf as a pending observation
-- adds a sighting instead of a duplicate. Returns { observation_id, merged }.
create or replace function submit_shopper_observation(
  p_store_id text, p_candidate jsonb, p_confidence text, p_evidence text
) returns jsonb language plpgsql as $$
declare v_key text; v_id text;
begin
  v_key := lower(trim(coalesce(p_candidate->>'brand', '') || ' ' || coalesce(p_candidate->>'name', ''))) || '|' || coalesce(p_candidate->>'shelf', '');
  select id into v_id from observations
   where store_id = p_store_id and review_status = 'NEEDS_REVIEW'
     and lower(trim(coalesce(candidate_json->>'brand', '') || ' ' || coalesce(candidate_json->>'name', ''))) || '|' || coalesce(candidate_json->>'shelf', '') = v_key
   order by created_at limit 1 for update;
  if v_id is not null then
    update observations set sightings = sightings + 1, evidence = left(p_evidence, 1000) where id = v_id;
    return jsonb_build_object('observation_id', v_id, 'merged', true);
  end if;
  insert into observations (store_id, source, candidate_json, confidence, evidence)
  values (p_store_id, 'shopper', p_candidate, p_confidence, left(p_evidence, 1000))
  returning id into v_id;
  insert into audit_events (store_id, actor_label, action, entity, entity_id, new_json)
  values (p_store_id, 'Shopper (anonymous, consented)', 'observation.submit', 'observation', v_id, jsonb_build_object('status', 'NEEDS_REVIEW'));
  return jsonb_build_object('observation_id', v_id, 'merged', false);
end $$;

-- ───────────────────────────── move_product_checked ─────────────────────────────
-- PATCH /api/products/:id/location: optimistic version check + move_product in one transaction.
-- Returns { code: 'OK', version } or { code: 'NOT_FOUND' | 'CONFLICT', error }.
create or replace function move_product_checked(
  p_product_id text, p_shelf_id text, p_level text, p_expected_version int, p_actor uuid, p_actor_label text
) returns jsonb language plpgsql as $$
declare t products;
begin
  select * into t from products where id = p_product_id for update;
  if not found then return jsonb_build_object('code', 'NOT_FOUND', 'error', 'Product not found.'); end if;
  if p_expected_version is not null and t.version <> p_expected_version then
    return jsonb_build_object('code', 'CONFLICT', 'error', format('%s was changed by another employee. Reopen it and try again.', t.name));
  end if;
  perform move_product(p_product_id, p_shelf_id, p_level, p_actor, p_actor_label, null);
  update products set version = version + 1 where id = p_product_id;
  return jsonb_build_object('code', 'OK', 'version', t.version + 1);
end $$;

commit;
