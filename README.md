# StoreGuide

Voice-first indoor product finding for blind and low-vision shoppers. Stores keep a verified shelf-level inventory, and shoppers ask for an item and hear a computed route to it.

## Run it

```bash
npm install
cp .env.example .env.local   # optional: leave it empty to use the seeded in-memory store
npm run dev                  # http://localhost:3000
npm test                     # unit tests (routing, search, seed integrity)
```

Try the API:

```bash
curl "localhost:3000/api/products?store_id=demo-store&query=almond%20milk"
curl -X POST localhost:3000/api/routes -H 'content-type: application/json' \
  -d '{"store_id":"demo-store","start_node_id":"N01","product_id":"P06"}'
```

## Supabase setup

1. Create a project and copy its URL and anon key into `.env.local`.
2. In the SQL editor, run `supabase/migrations/001_init.sql`, then `supabase/seed.sql`.
3. Create a staff user (Auth → Users), then run `insert into store_staff (store_id, user_id) values ('demo-store', '<user uuid>');`

Once `NEXT_PUBLIC_SUPABASE_URL` is set, the app reads from Supabase instead of the in-memory seed.

## Layout

| Path | What |
|---|---|
| `docs/contracts.md` | IDs, enums, API contracts, and module ownership. **Read this first.** |
| `lib/types.ts` | Shared domain types |
| `lib/routing/` | A*, turn-by-turn templates, `planRoute` (pure) |
| `lib/search/` | Spoken-query normalization and product matching |
| `lib/seed/demo-store.ts` | Demo store data (the only source; `npm run seed:sql` regenerates `supabase/seed.sql`) |
| `lib/db/repo.ts` | Data access: Supabase, or in-memory when env vars aren't set |
| `app/api/` | Route handlers |
| `supabase/migrations/` | Schema, RLS, `move_product` transactional function |

This is Next.js 16. Read `node_modules/next/dist/docs/` before relying on older Next.js knowledge (e.g. `params` is async).
