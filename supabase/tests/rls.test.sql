-- Row-level security as the public (anon) key sees it (issue #6, 4G). Supabase grants table privileges to anon and
-- authenticated by default and relies on RLS; mirror that grant here, then read as anon (auth.uid() is null).
create function pg_temp.ok(cond boolean, label text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'FAIL %', label; end if;
  raise notice 'ok  %', label;
end $$;
grant usage on schema public to anon;
grant select on observations, audit_events, media, store_staff, agent_runs, nodes, shelves, products, product_locations to anon;

insert into products (id, store_id, name) values ('P-HIDDEN', 'demo-store', 'Not yet approved');
create temp table seen (what text, n bigint);
grant all on seen to anon;
set role anon;
insert into seen select 'observations', count(*) from observations;
insert into seen select 'audit', count(*) from audit_events;
insert into seen select 'media', count(*) from media;
insert into seen select 'staff', count(*) from store_staff;
insert into seen select 'nodes', count(*) from nodes;
insert into seen select 'products', count(*) from products;
insert into seen select 'locations', count(*) from product_locations;
insert into seen select 'unpublished', count(*) from products p where not exists (select 1 from product_locations l where l.product_id = p.id and l.status = 'PUBLISHED');
reset role;

select pg_temp.ok((select count(*) from observations) > 0 and (select n from seen where what = 'observations') = 0, 'anon reads no observations');
select pg_temp.ok((select count(*) from audit_events) > 0 and (select n from seen where what = 'audit') = 0, 'anon reads no audit events');
select pg_temp.ok((select n from seen where what = 'media') = 0 and (select n from seen where what = 'staff') = 0, 'anon reads no media or staff rows');
select pg_temp.ok((select n from seen where what = 'nodes') > 0 and (select n from seen where what = 'products') > 0, 'anon still reads the published map and products');
select pg_temp.ok((select n from seen where what = 'locations') = (select count(*) from product_locations where status = 'PUBLISHED'), 'anon reads published locations only');
select pg_temp.ok((select n from seen where what = 'unpublished') = 0 and exists (select 1 from products where id = 'P-HIDDEN'),
  'anon reads no product without a published location');
