-- Assertions for 005_map_editor.sql. Runs after 001–005 + seed and the 004 tests. Raises on any failure.
create function pg_temp.eq(got jsonb, key text, want text, label text) returns void language plpgsql as $$
begin
  if got->>key is distinct from want then raise exception 'FAIL %: % = % (want %) in %', label, key, got->>key, want, got; end if;
  raise notice 'ok  %', label;
end $$;
create function pg_temp.ok(cond boolean, label text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'FAIL %', label; end if;
  raise notice 'ok  %', label;
end $$;

-- An editor draft: entrance → shelf approach, shelf S-A1-1 placed, S-A1-2 not placed, one landmark.
create temp table g as select '{
  "nodes": [{"id":"N01","x":0.1,"y":0.9,"kind":"entrance","label":"the entrance"},
            {"id":"p2","x":0.3,"y":0.7,"kind":"shelf_approach","label":"the approach to Aisle 1, Section 1"}],
  "edges": [{"id":"E01","from":"N01","to":"p2","weight":6.3}],
  "shelves": [{"id":"S-A1-1","aisle":"1","section":"1","anchor":"p2","x":0.14,"y":0.6,"w":0.07,"h":0.19}],
  "landmarks": [{"id":"L1","node":"N01","description":"Green welcome banner"}],
  "height_m": 18
}'::jsonb as j;

create temp table v0 as select max(version) v from store_maps where store_id = 'demo-store';
select pg_temp.eq(save_map_draft('nope', '{}', null, 't'), 'code', 'NOT_FOUND', 'save to an unknown map');
select pg_temp.eq(save_map_draft('map-demo-v1', '{"nodes":[]}', null, 't'), 'draft_rev', '1', 'first save creates the draft');
select pg_temp.eq(save_map_draft('map-demo-v1', '{"nodes":[1]}', null, 't'), 'draft_rev', '2', 'second save replaces it');
select pg_temp.ok((select count(*) = 1 and max(version) = (select v + 1 from v0) from store_maps
  where store_id = 'demo-store' and status = 'DRAFT' and plan_json is not null), 'one editor draft row, next version');
select pg_temp.ok((select count(*) = 0 from nodes n join store_maps m on m.id = n.map_id where m.plan_json is not null), 'a draft writes no node rows');

select pg_temp.eq(publish_map('map-demo-v1', 1, (select j from g), null, 't'), 'code', 'CONFLICT', 'publish a stale draft revision');

insert into stores (id, name) values ('store-005', 'Other store');
insert into store_maps (id, store_id, version, status) values ('map-005', 'store-005', 1, 'PUBLISHED');
insert into nodes (id, map_id, x, y, kind, label) values ('X1', 'map-005', 0.5, 0.5, 'junction', 'x');
insert into shelves (id, map_id, aisle, section, anchor_node, x, y, w, h) values ('S-X-1', 'map-005', '9', '9', 'X1', 0, 0, 0.1, 0.1);
select pg_temp.eq(publish_map('map-demo-v1', 2,
  jsonb_set((select j from g), '{shelves}', '[{"id":"S-X-1","aisle":"1","section":"2","anchor":"p2","x":0,"y":0,"w":0.1,"h":0.1}]'), null, 't'),
  'code', 'INVALID', 'shelf ID owned by another store');
select pg_temp.ok((select status = 'PUBLISHED' from store_maps where id = 'map-demo-v1'), 'refused publish changes nothing');

create temp table before as select (select count(*) from audit_events) a, (select count(*) from product_locations where status = 'PUBLISHED') l;
select pg_temp.eq(publish_map('map-demo-v1', 2, (select j from g), null, 't'), 'version', (select (v + 1)::text from v0), 'publish the draft');
select pg_temp.ok((select status = 'SUPERSEDED' from store_maps where id = 'map-demo-v1'), 'old map superseded');
select pg_temp.ok((select count(*) = 1 from store_maps where store_id = 'demo-store' and status = 'PUBLISHED' and version = (select v + 1 from v0)), 'new map published');
select pg_temp.ok(not shelf_on_published_map('S-DRAFT-T', 'demo-store'), 'an older non-editor draft is not published');
select pg_temp.ok(shelf_on_published_map('S-A1-1', 'demo-store'), 'placed shelf moved onto the new map');
select pg_temp.ok(not shelf_on_published_map('S-A1-2', 'demo-store'), 'unplaced shelf stays on the superseded map');
select pg_temp.ok((select s.anchor_node = m.id || ':p2' from shelves s join store_maps m on m.id = s.map_id where s.id = 'S-A1-1'), 'anchor points at the new node');
select pg_temp.ok((select count(*) = 2 from nodes n join store_maps m on m.id = n.map_id where m.status = 'PUBLISHED' and m.store_id = 'demo-store'), 'nodes materialized');
select pg_temp.ok(exists (select 1 from nodes where id = 'N01' and map_id = 'map-demo-v1'), 'old nodes kept');
select pg_temp.ok((select count(*) = 1 from landmarks l join nodes n on n.id = l.node_id join store_maps m on m.id = n.map_id where m.status = 'PUBLISHED' and m.store_id = 'demo-store'), 'landmark attached to the new node');
select pg_temp.ok((select height_m = 18 from stores where id = 'demo-store'), 'store height updated');
select pg_temp.ok((select count(*) from product_locations where status = 'PUBLISHED') = (select l from before), 'product locations untouched');
select pg_temp.ok((select count(*) from audit_events) = (select a from before) + 1
  and exists (select 1 from audit_events where action = 'map.publish' and (new_json->>'version')::int = (select v + 1 from v0)), 'one publish audit event');

select pg_temp.eq(publish_map('map-demo-v1', 2, (select j from g), null, 't'), 'code', 'CONFLICT', 'publish from a superseded map');
select pg_temp.eq(publish_map((select id from store_maps where store_id = 'demo-store' and status = 'PUBLISHED'), 0, (select j from g), null, 't'),
  'code', 'INVALID', 'publish with no draft');
select pg_temp.eq(save_map_draft((select id from store_maps where store_id = 'demo-store' and status = 'PUBLISHED'), '{}', null, 't'),
  'draft_rev', '1', 'next draft after publish');
select pg_temp.ok((select version = (select v + 2 from v0) from store_maps where store_id = 'demo-store' and status = 'DRAFT' and plan_json is not null), 'next draft takes the next version');

select pg_temp.ok(not has_function_privilege('anon', 'save_map_draft(text, jsonb, uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'publish_map(text, int, jsonb, uuid, text)', 'execute')
  and has_function_privilege('service_role', 'publish_map(text, int, jsonb, uuid, text)', 'execute'), 'map functions are server-only');
select pg_temp.ok(not has_column_privilege('anon', 'store_maps', 'plan_json', 'select')
  and not has_column_privilege('anon', 'store_maps', 'saved_by', 'select')
  and has_column_privilege('anon', 'store_maps', 'version', 'select'), 'editor payload is not readable by anon');
