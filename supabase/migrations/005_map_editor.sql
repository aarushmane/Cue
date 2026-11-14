-- Floor plan editor ⇄ Supabase (issue #6, 4D). Run after 004_review_v4.sql.
--
-- The editor works on a FloorPlan (lib/types.ts): normalized nodes with editor kinds ("walk"), edges, shelf
-- rectangles keyed by shelf ID, free-standing landmarks with a `verified` flag, a background plan and an aspect.
--
-- Gaps in the 001/002 tables, and how this migration closes them:
-- - Plan background, aspect, "walk" kind, landmark x/y + verified, unplaced shelf regions: no columns. The editor's
--   exact FloorPlan is kept as store_maps.plan_json (draft and published), so the editor reads back what it saved.
-- - shelves.id and nodes.id are GLOBAL primary keys, and product_locations reference shelves(id). A draft can't have
--   its own rows for shelf "S-A1-1" while the published map has one, and writing draft rows would move published
--   shelves. So a DRAFT is plan_json only. publish_map() materializes it into nodes/edges/shelves/landmarks:
--     nodes, edges, landmarks: new rows, ids namespaced "<map id>:<editor id>" (the superseded map keeps its rows,
--       so navigation_sessions.last_node and old landmarks stay valid);
--     shelves: upserted by shelf ID and moved onto the new map (product locations keep pointing at them). Shelves the
--       new map doesn't place stay on the superseded map, so shelf_on_published_map() is false for them.
-- - Shoppers keep reading the materialized tables (SupabaseRepo.getPublishedGraph), unchanged.
-- Node labels and edge weights are computed by the server (toStoreGraph in lib/map/graph.ts, same as memory mode)
-- and passed in p_graph; the server also re-runs mapChecks() before calling publish_map().

alter table store_maps add column plan_json jsonb;
alter table store_maps add column draft_rev int not null default 0;
alter table store_maps add column saved_at timestamptz;
alter table store_maps add column saved_by uuid references auth.users(id);
alter table store_maps add column published_by uuid references auth.users(id);
-- RLS lets anyone read the PUBLISHED map row. The editor payload (unverified landmarks, plan link) and who saved or
-- published it are staff data: keep anon/authenticated on the columns shoppers need. The server reads the rest with
-- the service role.
revoke select on store_maps from anon, authenticated;
grant select (id, store_id, version, status, created_at, published_at, created_by_agent_run) on store_maps to anon, authenticated;

-- Seeded landmarks were photographed and checked; editor landmarks start unverified.
alter table landmarks add column verified boolean not null default true;

-- ───────────────────────────── save_map_draft ─────────────────────────────
-- p_map_id: the store's PUBLISHED map (the editor's mapId, as in memory mode). Creates or replaces the store's
-- editor DRAFT version's plan_json and bumps draft_rev. Returns { code: 'OK', draft_id, draft_rev, saved_at } or
-- { code: 'NOT_FOUND', error }. Writes no node/shelf rows (see above), so nothing shoppers see changes.
create or replace function save_map_draft(p_map_id text, p_payload jsonb, p_actor uuid, p_actor_label text)
returns jsonb language plpgsql as $$
declare pub store_maps; d store_maps;
begin
  select * into pub from store_maps where id = p_map_id and status = 'PUBLISHED' for update;
  if not found then return jsonb_build_object('code', 'NOT_FOUND', 'error', 'Map not found.'); end if;
  if jsonb_typeof(p_payload) <> 'object' then return jsonb_build_object('code', 'INVALID', 'error', 'Invalid floor plan.'); end if;
  -- Editor drafts are the DRAFT rows with plan_json. Older DRAFT rows (rows written directly, plan_json null) are
  -- left alone and never published by this path, so their stray nodes/shelves can't reach shoppers.
  select * into d from store_maps where store_id = pub.store_id and status = 'DRAFT' and plan_json is not null
   order by version desc limit 1 for update;
  if not found then
    insert into store_maps (store_id, version, status)
    values (pub.store_id, (select max(version) + 1 from store_maps where store_id = pub.store_id), 'DRAFT')
    returning * into d;
  end if;
  update store_maps set plan_json = p_payload, draft_rev = d.draft_rev + 1, saved_at = now(), saved_by = p_actor
   where id = d.id returning * into d;
  return jsonb_build_object('code', 'OK', 'draft_id', d.id, 'draft_rev', d.draft_rev, 'saved_at', d.saved_at);
end $$;

-- ───────────────────────────── publish_map ─────────────────────────────
-- p_map_id: the store's PUBLISHED map. p_draft_rev: the draft revision the server checked (409 if it changed since).
-- p_graph: { nodes: [{id,x,y,kind,label}], edges: [{id,from,to,weight}], shelves: [{id,aisle,section,anchor,x,y,w,h}],
--            landmarks: [{id,node,description}], height_m } with editor ids (namespaced here).
-- DRAFT → PUBLISHED, old PUBLISHED → SUPERSEDED, one audit event. Returns { code: 'OK', map_id, version } or
-- { code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID', error }.
create or replace function publish_map(p_map_id text, p_draft_rev int, p_graph jsonb, p_actor uuid, p_actor_label text)
returns jsonb language plpgsql as $$
declare pub store_maps; d store_maps; v_version int; v_foreign text; v_counts jsonb;
begin
  select * into pub from store_maps where id = p_map_id for update;
  if not found then return jsonb_build_object('code', 'NOT_FOUND', 'error', 'Map not found.'); end if;
  if pub.status <> 'PUBLISHED' then
    return jsonb_build_object('code', 'CONFLICT', 'error', 'A newer floor plan was published since you opened this one. Reload the editor.');
  end if;
  select * into d from store_maps where store_id = pub.store_id and status = 'DRAFT' and plan_json is not null
   order by version desc limit 1 for update;
  if not found then return jsonb_build_object('code', 'INVALID', 'error', 'Save a draft before publishing.'); end if;
  if d.draft_rev <> p_draft_rev then
    return jsonb_build_object('code', 'CONFLICT', 'error', 'The draft was saved again since you checked it. Review it and publish again.');
  end if;

  -- Shelf IDs are global: refuse one that belongs to another store's map.
  select s.id into v_foreign from shelves s join store_maps m on m.id = s.map_id
   where s.id in (select el->>'id' from jsonb_array_elements(p_graph->'shelves') as t(el)) and m.store_id <> pub.store_id limit 1;
  if v_foreign is not null then
    return jsonb_build_object('code', 'INVALID', 'error', format('Shelf ID %s is already used by another store.', v_foreign));
  end if;

  insert into nodes (id, map_id, x, y, kind, label)
  select d.id || ':' || (n->>'id'), d.id, (n->>'x')::float8, (n->>'y')::float8, n->>'kind', n->>'label'
    from jsonb_array_elements(p_graph->'nodes') n;
  insert into edges (id, map_id, from_node, to_node, weight)
  select d.id || ':' || (e->>'id'), d.id, d.id || ':' || (e->>'from'), d.id || ':' || (e->>'to'), (e->>'weight')::float8
    from jsonb_array_elements(p_graph->'edges') e;
  insert into shelves (id, map_id, aisle, section, anchor_node, x, y, w, h)
  select s->>'id', d.id, s->>'aisle', s->>'section', d.id || ':' || (s->>'anchor'),
         (s->>'x')::float8, (s->>'y')::float8, (s->>'w')::float8, (s->>'h')::float8
    from jsonb_array_elements(p_graph->'shelves') s
  on conflict (id) do update set map_id = excluded.map_id, aisle = excluded.aisle, section = excluded.section,
    anchor_node = excluded.anchor_node, x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h;
  insert into landmarks (id, node_id, description, verified)
  select d.id || ':' || (l->>'id'), d.id || ':' || (l->>'node'), l->>'description', true
    from jsonb_array_elements(coalesce(p_graph->'landmarks', '[]'::jsonb)) l;

  -- Supersede first: the unique index allows one PUBLISHED map per store.
  update store_maps set status = 'SUPERSEDED' where id = pub.id;
  update store_maps set status = 'PUBLISHED', published_at = now(), published_by = p_actor where id = d.id;
  if (p_graph->>'height_m') is not null then
    update stores set height_m = (p_graph->>'height_m')::float8 where id = pub.store_id;
  end if;

  v_counts := jsonb_build_object('shelves', jsonb_array_length(p_graph->'shelves'), 'nodes', jsonb_array_length(p_graph->'nodes'),
                                 'edges', jsonb_array_length(p_graph->'edges'));
  insert into audit_events (store_id, actor_id, actor_label, action, entity, entity_id, old_json, new_json)
  values (pub.store_id, p_actor, p_actor_label, 'map.publish', 'store_map', d.id,
          jsonb_build_object('map_id', pub.id, 'version', pub.version),
          jsonb_build_object('map_id', d.id, 'version', d.version) || v_counts);
  return jsonb_build_object('code', 'OK', 'map_id', d.id, 'version', d.version);
end $$;

-- ───────────────────────────── grants ─────────────────────────────
-- Server-only (called with the service role after requireStaff). Supabase exposes public functions over PostgREST
-- with a default PUBLIC execute grant, so revoke it, as 003 and 004 do.
revoke execute on function save_map_draft(text, jsonb, uuid, text) from public, anon, authenticated;
revoke execute on function publish_map(text, int, jsonb, uuid, text) from public, anon, authenticated;
grant execute on function save_map_draft(text, jsonb, uuid, text) to service_role;
grant execute on function publish_map(text, int, jsonb, uuid, text) to service_role;
