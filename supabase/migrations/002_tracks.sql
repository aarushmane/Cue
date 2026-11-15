-- Additions for the CoStar (digital twin), Amazon (shopper agent) and LangChain (onboarding agent) features.

-- Store ↔ CoStar / Matterport / Vexcel identifiers.
alter table stores add column costar_property_id text;
alter table stores add column matterport_model_id text;
alter table stores add column vexcel_parcel_ref text;

-- Where a node came from. Matterport-imported nodes keep their sweep id so a re-import can be diffed.
alter table nodes add column source text not null default 'manual' check (source in ('manual', 'matterport', 'vexcel'));
alter table nodes add column sweep_id text;
alter table nodes drop constraint nodes_kind_check;
alter table nodes add constraint nodes_kind_check
  check (kind in ('entrance', 'junction', 'aisle_marker', 'shelf_approach', 'service', 'outdoor'));

-- Draft maps may come from the onboarding agent.
alter table store_maps add column created_by_agent_run text;

-- Shopper preferences the agent adapts to (verbosity, speech rate). No audio, images or location history.
alter table navigation_sessions add column prefs jsonb not null default '{}'::jsonb;

-- Shopper correction reports: shoppers can flag problems but never edit inventory (manual §02).
create table shopper_reports (
  id         text primary key default gen_random_uuid()::text,
  store_id   text not null references stores(id) on delete cascade,
  product_id text references products(id),
  note       text not null check (char_length(note) <= 500),
  status     text not null default 'OPEN' check (status in ('OPEN', 'RESOLVED', 'DISMISSED')),
  created_at timestamptz not null default now()
);
alter table shopper_reports enable row level security;
create policy "staff read reports" on shopper_reports for select using (is_store_staff(store_id));

-- Onboarding agent runs: plan, progress log and outputs, shown on the business "Import" screen.
create table agent_runs (
  id          text primary key default gen_random_uuid()::text,
  store_id    text references stores(id) on delete cascade,
  kind        text not null check (kind in ('onboarding')),
  status      text not null default 'RUNNING' check (status in ('RUNNING', 'SUCCEEDED', 'FAILED')),
  input_json  jsonb not null,
  todos_json  jsonb not null default '[]'::jsonb,
  log_json    jsonb not null default '[]'::jsonb,
  output_json jsonb,
  started_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);
alter table agent_runs enable row level security;
create policy "staff read agent runs" on agent_runs for select using (store_id is null or is_store_staff(store_id));
