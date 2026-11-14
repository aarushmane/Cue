# StoreGuide

Voice-first indoor product finding for blind and low-vision shoppers. Stores keep a verified shelf-level inventory, and shoppers ask for an item and hear a computed route to it.

## Run it

```bash
npm install
cp .env.example .env.local   # optional: leave it empty to use the seeded in-memory store
npm run dev                  # http://localhost:3000
npm test                     # unit tests (routing, search, review workflow, floor plan graph)
npm run test:e2e             # Playwright: v4 handoff scenarios + accessibility checks (starts `next dev` on :3100)
PW_CHANNEL=chrome npm run test:e2e   # same, using an installed Google Chrome
```

Open `/shopper` (voice-first shopper app) or `/business` (store manager: Home, Floor Plan, Review, More).

Try the API:

```bash
curl "localhost:3000/api/products?store_id=demo-store&query=almond%20milk"
curl -X POST localhost:3000/api/routes -H 'content-type: application/json' \
  -d '{"store_id":"demo-store","start_node_id":"N01","product_id":"P06"}'
```

## AI features

Set `GEMINI_API_KEY` (free tier, Google AI Studio) or `ANTHROPIC_API_KEY` in `.env.local`. With both set, Anthropic wins unless `AI_PROVIDER=gemini`. Gemini uses `gemini-3.1-flash-lite` (override with `GEMINI_MODEL`); Claude uses `claude-opus-5-5` (override with `CLAUDE_MODEL`) with server-side refusal fallback. Every provider goes through the same tools and the same zod validation (`lib/ai/provider.ts`, `lib/ai/structured.ts`). Without any key, the agent and localization routes return 503 and the app falls back to typed search and buttons. The free tier is rate-limited per model per day (`gemini-3.5-flash` measured at 20 requests/day; one onboarding run uses about 8–10), so develop on flash-lite, set `GEMINI_AGENT_MODEL=gemini-3.5-flash` only for the demo recording, and don't loop scans during judging.

```bash
# onboarding agent on fixture data (memory mode: set STAFF_DEMO_TOKEN=dev in .env.local)
curl -X POST localhost:3000/api/agent/onboard -H 'authorization: Bearer dev' -H 'content-type: application/json' \
  -d '{"costar_property_id":"fixture-property-1"}'
# shopper agent, first turn
curl -X POST localhost:3000/api/agent/shopper -H 'content-type: application/json' \
  -d '{"nav":{"store_id":"demo-store","current_node_id":"N01","position_confidence":"CONFIRMED"},"history":[],"utterance":"I need eggs"}'
```

### Adaptive inventory
Every shopper scan (`/api/localize`) also lists the products visible in the frames. Where the shopper's position is known, they become inventory updates: items seen in place refresh "last seen"; new, moved or missing items become suggestions that staff approve or reject in the manager app at **`/business/sightings`** (More → Shopper sightings; approvals are logged to Activity). API clients use `/api/inventory/*` with a staff token (memory mode: `STAFF_DEMO_TOKEN`). Nothing reaches shoppers until approved. Only text is stored, never images. Apply `supabase/migrations/003_adaptive_inventory.sql` in Supabase mode.

### CoStar track data (real)
1. In the track Discord run `/costar-keys`; put `MATTERPORT_API_KEY`, `MATTERPORT_API_TOKEN`, `VEXCEL_API_KEY` in `.env.local`.
2. Download `models_index.csv` from the track quickstart page into `data/` (git-ignored). It maps CoStar property ids to Matterport models.
3. Optional: unzip the CoStar kit into `data/costar-kit/` and set `COSTAR_KIT_DIR=data/costar-kit`.
4. Onboard by CoStar id or Matterport model id, e.g. `{"costar_property_id":"9560712"}` (337 S Broadway, LA: Office/Retail, 86 scan points, 2 floors) or `{"costar_property_id":"bP9oEnqmeie"}` (941 Towne Ave, LA: Retail, 40 scan points). `fixture-property-1` still works.

The import uses Matterport anchor locations (position, floor, room, **navigation neighbors**) when the key exposes them, otherwise pano positions plus proximity edges that never cross a wall from the wall graph. Hackathon data is for hackathon use only: never commit it.

Track strategy: `docs/tracks.md`.

## Supabase setup

1. Create a project and copy its URL and anon key into `.env.local`.
2. In the SQL editor, run `supabase/migrations/001_init.sql`, then `002_tracks.sql`, then `003_adaptive_inventory.sql`, then `supabase/seed.sql`.
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
| `lib/agents/shopper/` | Shopper voice agent (Claude tool use): Amazon Practical AI track |
| `lib/agents/onboarding/` | Store onboarding deep agent (LangChain deepagents): LangChain and CoStar tracks |
| `lib/twin/` | Matterport scan points → draft walkable graph |
| `lib/costar/` | CoStar track layers: Matterport Model API (`matterport.ts`), Vexcel ortho (`vexcel.ts`), CoStar id → model join (`modelsIndex.ts`), CoStar kit (`costarKit.ts`); fixture when no Matterport key |
| `lib/vision/` | Landmark matching (localization) and shelf recognition |
| `lib/auth/requireStaff.ts` | Staff checks for every mutation route |
| `app/api/` | Route handlers |
| `app/business/`, `components/business/`, `components/map/` | Store manager screens (v4 design handoff) |
| `app/shopper/`, `components/shopper/` | Shopper screens: voice search, results, destination, help, settings, consent, observation scan |
| `lib/review/`, `lib/map/graph.ts` | `validate()`, `findMatches()`, `routeTo()`, `reachable()`, `mapChecks()`, shared by UI and server |
| `lib/demo/adapter.ts` | **Demo adapter**: Server Functions over the in-memory `lib/db/demoState.ts` for staff writes that have no API route yet. Not durable, no real auth; screens keep "Demo action" labels |
| `supabase/migrations/` | Schema, RLS, `move_product` transactional function |

This is Next.js 16. Read `node_modules/next/dist/docs/` before relying on older Next.js knowledge (e.g. `params` is async).
