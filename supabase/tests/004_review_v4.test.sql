-- Assertions for 004_review_v4.sql. Runs after 001–004 + seed (see scripts/test-db.sh). Raises on any failure.
create function pg_temp.eq(got jsonb, key text, want text, label text) returns void language plpgsql as $$
begin
  if got->>key is distinct from want then raise exception 'FAIL %: % = % (want %) in %', label, key, got->>key, want, got; end if;
  raise notice 'ok  %', label;
end $$;

insert into observations (id, store_id, source, candidate_json) values
  ('OBS-T1', 'demo-store', 'ai', '{"name":"Califia Oat","brand":"Califia"}'),
  ('OBS-T2', 'demo-store', 'ai', '{"name":"x"}'),
  ('OBS-T3', 'demo-store', 'ai', '{"name":"Oatly"}');

select pg_temp.eq(review_observation('OBS-T1', 'publish', 1, null, 't', null,
  '{"name":"Califia Oat Milk","brand":"Califia","size":"48 oz","category":"Dairy alternatives"}', 'S-A1-1', 'middle', null, null, true),
  'status', 'EDITED', 'publish new product');
select pg_temp.eq(review_observation('OBS-T1', 'publish', 2, null, 't', null, '{"name":"a"}', 'S-A1-1', 'middle'),
  'code', 'ALREADY_REVIEWED', 'second review is refused');
select pg_temp.eq(review_observation('OBS-T2', 'reject', 9, null, 't', 'wrong item'), 'code', 'CONFLICT', 'stale observation version');
select pg_temp.eq(review_observation('OBS-T2', 'reject', 1, null, 't', 'no'), 'code', 'INVALID', 'short reason');
select pg_temp.eq(review_observation('OBS-T2', 'rescan', 1, null, 't', 'blurry photo'), 'status', 'NEEDS_RESCAN', 'rescan');
select pg_temp.eq(review_observation('OBS-T3', 'publish', 1, null, 't', null, '{"name":"Oatly Oat Milk"}', 'S-A1-1', 'top', 'P01', 5),
  'code', 'TARGET_CONFLICT', 'stale merge target');
select pg_temp.eq(review_observation('OBS-T3', 'publish', 1, null, 't', null, '{"name":"Oatly Oat Milk"}', 'S-A1-1', 'top', 'P01', 1),
  'product_id', 'P01', 'merge into existing product');

do $$ begin
  if (select count(*) from product_locations where product_id = 'P01' and status = 'PUBLISHED') <> 1 then raise exception 'FAIL one published location'; end if;
  if (select version from products where id = 'P01') <> 2 then raise exception 'FAIL product version bumped'; end if;
  raise notice 'ok  one published location, version bumped';
end $$;

select pg_temp.eq(move_product_checked('P02', 'S-A1-1', 'lower', 9, null, 't'), 'code', 'CONFLICT', 'move with stale version');
select pg_temp.eq(move_product_checked('P02', 'S-A1-1', 'lower', 1, null, 't'), 'version', '2', 'move with current version');
select pg_temp.eq(move_product_checked('nope', 'S-A1-1', 'lower', 1, null, 't'), 'code', 'NOT_FOUND', 'move unknown product');

select pg_temp.eq(submit_shopper_observation('demo-store', '{"name":"Skyr","brand":"Siggi''s","shelf":"S1"}', 'Medium', 'seen'),
  'merged', 'false', 'shopper submission');
select pg_temp.eq(submit_shopper_observation('demo-store', '{"name":"skyr ","brand":"siggi''s","shelf":"S1"}', 'Medium', 'again'),
  'merged', 'true', 'identical pending submission adds a sighting');
do $$ begin
  if (select sightings from observations where source = 'shopper') <> 2 then raise exception 'FAIL sightings = 2'; end if;
  raise notice 'ok  sightings counted, no media stored';
end $$;

-- Mutation functions must not be callable with the anon/authenticated keys (PostgREST RPC).
do $$ begin
  if has_function_privilege('anon', 'review_observation(text, text, int, uuid, text, text, jsonb, text, text, text, int, boolean)', 'execute')
     or has_function_privilege('authenticated', 'move_product_checked(text, text, text, int, uuid, text)', 'execute')
     or has_function_privilege('anon', 'submit_shopper_observation(text, jsonb, text, text)', 'execute') then
    raise exception 'FAIL anon/authenticated can execute a server-only function';
  end if;
  if not has_function_privilege('service_role', 'review_observation(text, text, int, uuid, text, text, jsonb, text, text, text, int, boolean)', 'execute') then
    raise exception 'FAIL service_role cannot execute review_observation';
  end if;
  raise notice 'ok  server-only functions are not exposed to anon/authenticated';
end $$;
