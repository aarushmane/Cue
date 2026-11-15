-- Fix: the products and product_locations read policies (001_init.sql) referenced each other, so ANY read of either
-- table through the anon/authenticated key failed with "infinite recursion detected in policy for relation products"
-- (shopper search in Supabase mode reads them with the anon key). Found by supabase/tests/rls.test.sql.
--
-- The cross-table checks move into SECURITY DEFINER helpers, which read the other table without re-entering its
-- policy. Both return a boolean only, so they reveal nothing the policies didn't already allow.

create or replace function product_is_published(p_product_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from product_locations l where l.product_id = p_product_id and l.status = 'PUBLISHED')
$$;

create or replace function is_product_staff(p_product_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from products p where p.id = p_product_id and is_store_staff(p.store_id))
$$;

drop policy if exists "public read products with published location" on products;
create policy "public read products with published location" on products for select using (
  is_store_staff(store_id) or product_is_published(id));

drop policy if exists "public read published locations" on product_locations;
create policy "public read published locations" on product_locations for select using (
  status = 'PUBLISHED' or is_product_staff(product_id));

-- Policies run as the caller, so these must stay executable by anon/authenticated (unlike the write functions).
grant execute on function product_is_published(text) to anon, authenticated, service_role;
grant execute on function is_product_staff(text) to anon, authenticated, service_role;
