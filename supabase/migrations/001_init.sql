-- StoreGuide initial schema (manual §10). IDs are text so seed data and docs can use readable IDs (N01, S-A2-1, P06).
-- New rows default to a random UUID string.

create extension if not exists pgcrypto;

-- ───────────────────────────── Store & map ─────────────────────────────
create table stores (
  id            text primary key default gen_random_uuid()::text,
  name          text not null,
  address       text,
  latitude      double precision,
  longitude     double precision,
  width_m       double precision not null default 30,
  height_m      double precision not null default 20,
  floor_plan_url text,
  created_at    timestamptz not null default now()
);

-- Staff membership: which auth users may edit which store.
create table store_staff (
  store_id   text not null references stores(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'staff' check (role in ('staff', 'admin')),
  primary key (store_id, user_id)
);

create table store_maps (
  id         text primary key default gen_random_uuid()::text,
  store_id   text not null references stores(id) on delete cascade,
  version    int  not null,
  status     text not null default 'DRAFT' check (status in ('DRAFT', 'PUBLISHED', 'SUPERSEDED')),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (store_id, version)
);
-- At most one published map per store.
create unique index one_published_map_per_store on store_maps (store_id) where status = 'PUBLISHED';

create table nodes (
  id         text primary key default gen_random_uuid()::text,
  map_id     text not null references store_maps(id) on delete cascade,
  x          double precision not null check (x between 0 and 1),
  y          double precision not null check (y between 0 and 1),
  kind       text not null check (kind in ('entrance', 'junction', 'aisle_marker', 'shelf_approach', 'service')),
  label      text not null,
  facing_deg double precision
);
create index on nodes (map_id);

create table edges (
  id        text primary key default gen_random_uuid()::text,
  map_id    text not null references store_maps(id) on delete cascade,
  from_node text not null references nodes(id) on delete cascade,
  to_node   text not null references nodes(id) on delete cascade,
  weight    double precision not null check (weight >= 0),
  check (from_node <> to_node)
);
create index on edges (map_id);

create table shelves (
  id          text primary key default gen_random_uuid()::text,
  map_id      text not null references store_maps(id) on delete cascade,
  aisle       text not null,
  section     text not null,
  anchor_node text not null references nodes(id),
  x double precision not null, y double precision not null,
  w double precision not null, h double precision not null,
  unique (map_id, aisle, section)
);

-- ───────────────────────────── Catalog & locations ─────────────────────────────
create table products (
  id         text primary key default gen_random_uuid()::text,
  store_id   text not null references stores(id) on delete cascade,
  name       text not null,
  brand      text,
  variant    text,
  size       text,
  barcode    text,
  aliases    text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index on products (store_id);

-- Moving a product supersedes the old row and inserts a new one, so this table is also the location history.
create table product_locations (
  id          text primary key default gen_random_uuid()::text,
  product_id  text not null references products(id) on delete cascade,
  shelf_id    text not null references shelves(id),
  level       text check (level in ('top', 'upper', 'middle', 'lower', 'bottom')),
  status      text not null default 'PUBLISHED' check (status in ('PUBLISHED', 'SUPERSEDED')),
  verified_at timestamptz not null default now(),
  verified_by uuid references auth.users(id),
  observation_id text,
  created_at  timestamptz not null default now()
);
create unique index one_published_location_per_product on product_locations (product_id) where status = 'PUBLISHED';

-- ───────────────────────────── Media & AI ─────────────────────────────
create table media (
  id          text primary key default gen_random_uuid()::text,
  store_id    text not null references stores(id) on delete cascade,
  shelf_id    text references shelves(id),
  url         text not null,           -- storage path in the private "media" bucket
  kind        text not null default 'image' check (kind in ('image', 'video_frame', 'landmark')),
  uploaded_by uuid references auth.users(id),
  created_at  timestamptz not null default now()
);

create table observations (
  id             text primary key default gen_random_uuid()::text,
  media_id       text not null references media(id) on delete cascade,
  candidate_json jsonb not null,        -- one validated candidate from the vision model
  review_status  text not null default 'NEEDS_REVIEW'
                 check (review_status in ('NEEDS_REVIEW', 'ACCEPTED', 'EDITED', 'REJECTED')),
  reviewed_by    uuid references auth.users(id),
  reviewed_at    timestamptz,
  product_id     text references products(id),
  created_at     timestamptz not null default now()
);
alter table product_locations
  add constraint product_locations_observation_fk foreign key (observation_id) references observations(id);

create table landmarks (
  id          text primary key default gen_random_uuid()::text,
  node_id     text not null references nodes(id) on delete cascade,
  media_id    text references media(id),
  image_url   text,
  description text not null
);

-- ───────────────────────────── Shopper & audit ─────────────────────────────
create table navigation_sessions (
  id         text primary key default gen_random_uuid()::text,
  store_id   text not null references stores(id) on delete cascade,
  product_id text references products(id),
  last_node  text references nodes(id),
  state      text not null default 'SEARCHING'
             check (state in ('SEARCHING', 'DESTINATION_SELECTED', 'LOCATING', 'ROUTING', 'GUIDING', 'ARRIVED', 'NEEDS_HELP')),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '2 hours'
);

create table audit_events (
  id         bigint generated always as identity primary key,
  store_id   text not null references stores(id) on delete cascade,
  actor_id   uuid references auth.users(id),
  actor_label text,                      -- e.g. "seed", staff email; never shopper data
  action     text not null,
  entity     text not null,
  entity_id  text,
  old_json   jsonb,
  new_json   jsonb,
  media_id   text references media(id),
  created_at timestamptz not null default now()
);
create index on audit_events (store_id, created_at desc);

-- Append-only: block updates and deletes on the audit log.
create function forbid_audit_mutation() returns trigger language plpgsql as $$
begin raise exception 'audit_events is append-only'; end $$;
create trigger audit_events_append_only before update or delete on audit_events
  for each row execute function forbid_audit_mutation();

-- ───────────────────────────── Integrity helpers ─────────────────────────────
-- Product location must reference a shelf whose map belongs to the product's store.
create function check_location_same_store() returns trigger language plpgsql as $$
declare p_store text; s_store text;
begin
  select store_id into p_store from products where id = new.product_id;
  select m.store_id into s_store from shelves s join store_maps m on m.id = s.map_id where s.id = new.shelf_id;
  if p_store is distinct from s_store then
    raise exception 'product % and shelf % belong to different stores', new.product_id, new.shelf_id;
  end if;
  return new;
end $$;
create trigger product_locations_same_store before insert or update on product_locations
  for each row execute function check_location_same_store();

-- Atomic move: supersede current location, insert new one, write audit event. Called by PATCH /api/products/:id/location
-- with the service role after the route has verified the caller is staff for this store.
create function move_product(
  p_product_id text, p_shelf_id text, p_level text, p_actor uuid, p_actor_label text, p_observation_id text default null
) returns product_locations language plpgsql as $$
declare old_row product_locations; new_row product_locations; p_store text;
begin
  select store_id into p_store from products where id = p_product_id;
  if p_store is null then raise exception 'unknown product %', p_product_id; end if;

  update product_locations set status = 'SUPERSEDED'
   where product_id = p_product_id and status = 'PUBLISHED'
  returning * into old_row;

  insert into product_locations (product_id, shelf_id, level, verified_by, observation_id)
  values (p_product_id, p_shelf_id, p_level, p_actor, p_observation_id)
  returning * into new_row;

  insert into audit_events (store_id, actor_id, actor_label, action, entity, entity_id, old_json, new_json)
  values (p_store, p_actor, p_actor_label,
          case when old_row.id is null then 'location.publish' else 'location.move' end,
          'product', p_product_id,
          case when old_row.id is null then null else jsonb_build_object('shelf_id', old_row.shelf_id, 'level', old_row.level) end,
          jsonb_build_object('shelf_id', new_row.shelf_id, 'level', new_row.level));
  return new_row;
end $$;

-- ───────────────────────────── Row-level security ─────────────────────────────
-- Shoppers (anon) can read only published map + published locations. All writes go through server routes
-- using the service role after an explicit staff check, so no insert/update policies are granted to anon/auth.
alter table stores              enable row level security;
alter table store_staff         enable row level security;
alter table store_maps          enable row level security;
alter table nodes               enable row level security;
alter table edges               enable row level security;
alter table shelves             enable row level security;
alter table products            enable row level security;
alter table product_locations   enable row level security;
alter table media               enable row level security;
alter table observations        enable row level security;
alter table landmarks           enable row level security;
alter table navigation_sessions enable row level security;
alter table audit_events        enable row level security;

create function is_store_staff(sid text) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from store_staff where store_id = sid and user_id = auth.uid())
$$;

create policy "public read stores" on stores for select using (true);
create policy "public read published maps" on store_maps for select using (status = 'PUBLISHED' or is_store_staff(store_id));
create policy "public read nodes" on nodes for select using (
  exists (select 1 from store_maps m where m.id = map_id and (m.status = 'PUBLISHED' or is_store_staff(m.store_id))));
create policy "public read edges" on edges for select using (
  exists (select 1 from store_maps m where m.id = map_id and (m.status = 'PUBLISHED' or is_store_staff(m.store_id))));
create policy "public read shelves" on shelves for select using (
  exists (select 1 from store_maps m where m.id = map_id and (m.status = 'PUBLISHED' or is_store_staff(m.store_id))));
create policy "public read landmarks" on landmarks for select using (true);
create policy "public read products with published location" on products for select using (
  is_store_staff(store_id) or exists (select 1 from product_locations l where l.product_id = products.id and l.status = 'PUBLISHED'));
create policy "public read published locations" on product_locations for select using (
  status = 'PUBLISHED' or exists (select 1 from products p where p.id = product_locations.product_id and is_store_staff(p.store_id)));
create policy "staff read own staff rows" on store_staff for select using (user_id = auth.uid());
create policy "staff read media" on media for select using (is_store_staff(store_id));
create policy "staff read observations" on observations for select using (
  exists (select 1 from media m where m.id = media_id and is_store_staff(m.store_id)));
create policy "staff read audit" on audit_events for select using (is_store_staff(store_id));
-- navigation_sessions: no client policies; only server routes (service role) touch them.

-- Storage: create a PRIVATE bucket named "media" in the dashboard (or via the line below). Uploads use signed URLs.
insert into storage.buckets (id, name, public) values ('media', 'media', false) on conflict (id) do nothing;
