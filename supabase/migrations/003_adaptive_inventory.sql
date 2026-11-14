-- Adaptive inventory: shopper camera sightings → suggestions → staff approval → published list.
-- Stores structured text only (no images, no shopper identity). All writes go through server routes with the
-- service role; the functions below are not callable by anon/authenticated clients.

alter table products add column if not exists category text;
alter table product_locations add column if not exists last_seen_at timestamptz;
alter table product_locations add column if not exists miss_count int not null default 0;

create table inventory_suggestions (
  id             text primary key default gen_random_uuid()::text,
  store_id       text not null references stores(id) on delete cascade,
  kind           text not null check (kind in ('NEW_PRODUCT', 'MOVED', 'MISSING')),
  status         text not null default 'COLLECTING'
                 check (status in ('COLLECTING', 'PENDING', 'APPROVED', 'REJECTED', 'AUTO_RESOLVED')),
  key            text not null,
  product_id     text references products(id) on delete cascade,
  proposed       jsonb not null,            -- { name, brand, variant, size, category }
  shelf_counts   jsonb not null default '{}'::jsonb,  -- shelf id → sightings
  sighting_count int not null default 0,
  threshold      int not null default 1,
  evidence       jsonb not null default '[]'::jsonb,  -- last few vision evidence strings
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  reviewed_by    uuid references auth.users(id),
  reviewed_at    timestamptz,
  review_note    text,
  -- MOVED/MISSING always name a product; NEW_PRODUCT gets one only when approval creates it.
  check ((kind = 'NEW_PRODUCT' and (product_id is null or status = 'APPROVED')) or (kind <> 'NEW_PRODUCT' and product_id is not null))
);
create unique index one_open_suggestion_per_key on inventory_suggestions (store_id, key) where status in ('COLLECTING', 'PENDING');
create index on inventory_suggestions (store_id, status, last_seen_at desc);
alter table inventory_suggestions enable row level security;
create policy "staff read suggestions" on inventory_suggestions for select using (is_store_staff(store_id));

-- Seen at its listed shelf: refresh freshness and auto-resolve any open MISSING suggestion.
create function confirm_sightings(p_store_id text, p_product_ids text[]) returns void language plpgsql as $$
begin
  update product_locations l set last_seen_at = now(), miss_count = 0
    from products p
   where p.id = l.product_id and p.store_id = p_store_id and l.status = 'PUBLISHED' and l.product_id = any(p_product_ids);
  update inventory_suggestions set status = 'AUTO_RESOLVED', reviewed_at = now(), review_note = 'Seen again by a shopper.'
   where store_id = p_store_id and kind = 'MISSING' and status in ('COLLECTING', 'PENDING') and product_id = any(p_product_ids);
end $$;

-- Add one sighting to the open suggestion for this key (creating it), and promote to PENDING at the threshold.
create function record_sighting(
  p_store_id text, p_kind text, p_key text, p_product_id text, p_proposed jsonb, p_shelf_ids text[], p_evidence text, p_threshold int
) returns void language plpgsql as $$
declare s inventory_suggestions; sh text; counts jsonb;
begin
  if p_product_id is not null and not exists (select 1 from products where id = p_product_id and store_id = p_store_id) then
    raise exception 'product % is not in store %', p_product_id, p_store_id;
  end if;
  if p_kind = 'MISSING' then
    update product_locations set miss_count = miss_count + 1 where product_id = p_product_id and status = 'PUBLISHED';
  end if;

  select * into s from inventory_suggestions
   where store_id = p_store_id and key = p_key and status in ('COLLECTING', 'PENDING') for update;
  if not found then
    insert into inventory_suggestions (store_id, kind, key, product_id, proposed, threshold)
    values (p_store_id, p_kind, p_key, p_product_id, p_proposed, p_threshold)
    returning * into s;
  end if;

  counts := s.shelf_counts;
  foreach sh in array coalesce(p_shelf_ids, '{}') loop
    counts := jsonb_set(counts, array[sh], to_jsonb(coalesce((counts ->> sh)::int, 0) + 1));
  end loop;

  update inventory_suggestions set
    sighting_count = s.sighting_count + 1,
    last_seen_at   = now(),
    shelf_counts   = counts,
    evidence       = (select coalesce(jsonb_agg(e), '[]'::jsonb) from (
                        select e from jsonb_array_elements(jsonb_build_array(left(p_evidence, 300)) || s.evidence) e limit 5) x),
    status         = case when s.status = 'COLLECTING' and s.sighting_count + 1 >= s.threshold then 'PENDING' else s.status end
  where id = s.id;
end $$;

-- Staff approval. NEW_PRODUCT → insert product + publish location; MOVED → move_product; MISSING → unpublish.
create function approve_suggestion(
  p_id text, p_shelf_id text, p_level text, p_edits jsonb, p_note text, p_actor uuid, p_actor_label text
) returns jsonb language plpgsql as $$
declare s inventory_suggestions; prop jsonb; shelf text; pid text; old_loc product_locations;
begin
  select * into s from inventory_suggestions where id = p_id for update;
  if not found then raise exception 'suggestion not found'; end if;
  if s.status <> 'PENDING' then raise exception 'suggestion is not pending (%)', s.status; end if;

  prop  := s.proposed || coalesce(p_edits, '{}'::jsonb);
  shelf := coalesce(p_shelf_id, (select key from jsonb_each_text(s.shelf_counts) order by value::int desc, key limit 1));
  pid   := s.product_id;

  if s.kind = 'NEW_PRODUCT' then
    if shelf is null or coalesce(trim(prop ->> 'name'), '') = '' then raise exception 'a shelf and a product name are required'; end if;
    insert into products (store_id, name, brand, variant, size, category)
    values (s.store_id, trim(prop ->> 'name'), prop ->> 'brand', prop ->> 'variant', prop ->> 'size', prop ->> 'category')
    returning id into pid;
    perform move_product(pid, shelf, p_level, p_actor, p_actor_label);
    update product_locations set last_seen_at = s.last_seen_at where product_id = pid and status = 'PUBLISHED';
  elsif s.kind = 'MOVED' then
    if shelf is null then raise exception 'a shelf is required'; end if;
    perform move_product(pid, shelf, p_level, p_actor, p_actor_label);
  else
    update product_locations set status = 'SUPERSEDED' where product_id = pid and status = 'PUBLISHED' returning * into old_loc;
    if old_loc.id is null then raise exception 'this item is no longer listed'; end if;
    insert into audit_events (store_id, actor_id, actor_label, action, entity, entity_id, old_json)
    values (s.store_id, p_actor, p_actor_label, 'location.retire', 'product', pid, jsonb_build_object('shelf_id', old_loc.shelf_id, 'level', old_loc.level));
  end if;

  update inventory_suggestions set status = 'APPROVED', reviewed_by = p_actor, reviewed_at = now(), review_note = p_note, product_id = pid
   where id = s.id returning * into s;
  insert into audit_events (store_id, actor_id, actor_label, action, entity, entity_id, new_json)
  values (s.store_id, p_actor, p_actor_label, 'suggestion.approve', 'inventory_suggestion', s.id,
          jsonb_build_object('kind', s.kind, 'product_id', pid, 'shelf_id', shelf, 'sightings', s.sighting_count));
  return jsonb_build_object('suggestion', to_jsonb(s), 'product_id', pid);
end $$;

create function reject_suggestion(p_id text, p_note text, p_actor uuid, p_actor_label text) returns jsonb language plpgsql as $$
declare s inventory_suggestions;
begin
  update inventory_suggestions set status = 'REJECTED', reviewed_by = p_actor, reviewed_at = now(), review_note = p_note
   where id = p_id and status = 'PENDING' returning * into s;
  if not found then
    if exists (select 1 from inventory_suggestions where id = p_id) then raise exception 'suggestion is not pending'; end if;
    raise exception 'suggestion not found';
  end if;
  insert into audit_events (store_id, actor_id, actor_label, action, entity, entity_id, new_json)
  values (s.store_id, p_actor, p_actor_label, 'suggestion.reject', 'inventory_suggestion', s.id, jsonb_build_object('kind', s.kind, 'note', p_note));
  return jsonb_build_object('suggestion', to_jsonb(s), 'product_id', s.product_id);
end $$;

-- Mutation functions are server-only (service role). Supabase exposes functions over RPC, so revoke the default
-- PUBLIC execute grant. This also closes move_product from 001, which was callable via RPC.
revoke execute on function move_product(text, text, text, uuid, text, text) from public, anon, authenticated;
revoke execute on function confirm_sightings(text, text[]) from public, anon, authenticated;
revoke execute on function record_sighting(text, text, text, text, jsonb, text[], text, int) from public, anon, authenticated;
revoke execute on function approve_suggestion(text, text, text, jsonb, text, uuid, text) from public, anon, authenticated;
revoke execute on function reject_suggestion(text, text, uuid, text) from public, anon, authenticated;
grant execute on function move_product(text, text, text, uuid, text, text) to service_role;
grant execute on function confirm_sightings(text, text[]) to service_role;
grant execute on function record_sighting(text, text, text, text, jsonb, text[], text, int) to service_role;
grant execute on function approve_suggestion(text, text, text, jsonb, text, uuid, text) to service_role;
grant execute on function reject_suggestion(text, text, uuid, text) to service_role;
