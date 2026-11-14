-- Minimal stand-ins for Supabase-managed schemas so the migrations run on plain Postgres (tests only).
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql as 'select null::uuid';
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean);
create table storage.objects (id text, bucket_id text);
do $$ begin create role anon; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
do $$ begin create role service_role; exception when duplicate_object then null; end $$;
