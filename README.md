# StoreGuide

Voice-first indoor product finding for blind and low-vision shoppers, plus a Matterport-Showcase-style 3D walkthrough of each store's scan.

- `/` — the 3D walkthrough (simulated in-store POV) of the supplied scan `Muo5jpq44Xk`.
- `/scene/:propertyId` — the walkthrough for a saved CoStar property.
- `/shopper` and `/business` — the shopper and store-manager apps (see [Shopper and manager apps](#shopper-and-manager-apps)).

```sh
npm install
npm run dev   # http://localhost:3000
```

After `npm install` changes dependencies, restart `next dev`; a server started before the install can keep serving 500s.

## 3D walkthrough

- Drag to look around (the scene follows the pointer). Scroll or pinch to zoom.
- Select a spot on the floor to glide to the nearest scan position with a clear line of sight. The ring cursor shows where you are pointing and the destination marker lights up.
- With the canvas focused, W/S or ↑/↓ walk, A/D strafe, ←/→ turn. Walking keeps eye height above the floor, slides along walls and shelving, and stays within 0.3 m of the scan positions and the paths between them. When input stops, the camera glides onto the nearest scan position so every still frame is an undistorted panorama.

### Property data

Use `.env.local` for the Supabase settings in `.env.example`. The existing `stores` table already has `costar_property_id`, `matterport_model_id`, `name`, and `address`.

- `POST /api/db/properties`: insert a property/scan mapping using `Authorization: Bearer <PROPERTY_WRITE_TOKEN>`. Body: `{ "property_id": "236314", "matterport_model_id": "Muo5jpq44Xk", "name": "Sample Storefront", "address": "6301–6335 Ashcroft Dr, Houston, TX" }`. Retries return the existing row without updating it.
- `/scene/236314`: read the newest saved scan for that property from Supabase and open its walkthrough.

Run `npm run property:add-example` while the dev server is running to save the supplied property through the API. It reads the write token from the environment and does not print credentials.

### Rendering data

- `GET /api/scenes/:modelId` returns a render manifest: model ID, revision, units, coordinate conversion, mesh-proxy URL, skybox URL template, sweeps (position, floor height, rotation, neighbours) and the start sweep.
- `GET /api/scenes/:modelId/mesh` streams the original OBJ. `GET /api/scenes/:modelId/sweeps/:sweepId/:resolution/:face` streams one skybox face (`high` = 1024 px, `2k` = 2048 px; faces 0–5). Only models registered in `stores` are served.
- Matterport signs asset URLs for about five minutes, so metadata is cached in memory only until shortly before `validUntil`, and an expired link triggers one refresh. Credentials stay on the server.
- Three.js parses the OBJ and converts Z-up to Y-up once (`(x, y, z) → (x, z, -y)`).

### How the walkthrough is rendered (`components/scene/engine.ts`)

The API's OBJ has no UVs and the textured MatterPak is not available to this account, so — like Showcase — the viewer projects each sweep's skybox onto the mesh from the sweep's camera centre:

- Skybox convention (verified against the mesh by cross-sweep colour agreement): face 0 up, faces 1–4 horizon clockwise from above, face 5 down. In the pano-local frame face 1 looks along +x with image-right −y and up +z; the pano `rotation` quaternion maps pano-local to model (Z-up) coordinates. Faces are uploaded to GL cube slots `[+X, −X, +Y, −Y, +Z, −Z] = [2, 4, 0, 5, 1, 3]` and sampled with `g = (−Ly, Lz, Lx)`.
- Up to four nearby sweeps are blended per fragment. Weights fall off with the 8th power of camera-to-sweep distance, so standing on a sweep shows its photo exactly and moving cross-fades near the midpoint.
- A distance cubemap rendered from each sweep gates its projection, so photos never bleed through walls; surfaces no sweep can see fall back to the neutral `--scene-material` shading. Mesh holes show the nearest panorama by direction. Small disconnected mesh fragments are dropped on load.
- Panoramas load at `high`; the sweep you settle on upgrades to `2k`. GPU caches are LRU-bounded.

### Design system

Read [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) before frontend changes to the walkthrough. Run `npm run check:ui` with the dev server running for desktop/mobile screenshots and canvas/interaction checks (uses installed Google Chrome). The shopper and manager apps keep their own v4 theme in `app/legacy.css`, loaded only by their route layouts, so the two styling systems never meet on one page.

## Shopper and manager apps


### Run it

```bash
npm install
cp .env.example .env.local   # optional: leave it empty to use the seeded in-memory store
npm run dev                  # http://localhost:3000
npm test                     # unit tests (routing, search, review workflow, floor plan graph)
npm run test:e2e             # Playwright: v4 handoff scenarios + accessibility checks (starts `next dev` on :3100)
PW_CHANNEL=chrome npm run test:e2e   # same, using an installed Google Chrome
```

Open `/shopper` (voice-first shopper app; spoken requests go to the shopper agent on `/shopper/guide`, typed search stays plain search) or `/business` (store manager: Home, Floor Plan, Review, More). Onboard a store from a CoStar id at `/business/onboard` (More → Onboard a store); a run takes 1–3 minutes.

Try the API:

```bash
curl "localhost:3000/api/products?store_id=demo-store&query=almond%20milk"
curl -X POST localhost:3000/api/routes -H 'content-type: application/json' \
  -d '{"store_id":"demo-store","start_node_id":"N01","product_id":"P06"}'
```

### Testing on a phone

The mic and camera only work over HTTPS (or on `localhost`), so a phone on your Wi-Fi needs one of:

```bash
npx next dev --experimental-https              # self-signed cert: open https://<your-laptop-ip>:3000 and accept the warning
cloudflared tunnel --url http://localhost:3000 # or any tunnel (ngrok, etc.): real HTTPS URL, no warning
```

- **iPhone (Safari, iOS 18+):** the first tap anywhere unlocks spoken replies (iOS blocks speech output until a tap). Voice input needs Dictation on (Settings → General → Keyboard → Enable Dictation); otherwise the app says so and typing still works. Test with VoiceOver on as well.
- **Android (Chrome):** voice recognition sends audio to Google's servers, so it needs a connection. Test with TalkBack.
- **Both:** allow the mic and camera when asked. "Find my position" uses the back camera when there is one, takes about two seconds, and turns the camera off by itself.

### AI features

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

Run `npm run check:costar` after adding the keys: it confirms `neighbors`, floor plans, Vexcel coverage and LangSmith before you demo.

The import uses Matterport anchor locations (position, floor, room, **navigation neighbors**) when the key exposes them, otherwise pano positions plus proximity edges that never cross a wall from the wall graph. Hackathon data is for hackathon use only: never commit it.

Track strategy: `docs/tracks.md`.

### Get a LangSmith trace

The onboarding deep agent (`lib/agents/onboarding/agent.ts`) is traced end to end in LangSmith: the plan (`write_todos`), every tool call, the `shelf-recognizer` subagent and each model call.

1. Create an API key at [smith.langchain.com](https://smith.langchain.com) (Settings → API Keys).
2. Add to `.env.local` (never commit it) and restart `npm run dev`:
   ```bash
   LANGSMITH_TRACING=true
   LANGSMITH_API_KEY=lsv2_...
   LANGSMITH_PROJECT=storeguide   # optional; defaults to "default"
   ```
3. Run onboarding (the curl under [AI features](#ai-features)), then open the project in LangSmith.

Each run is named `onboard <property id>`, tagged `storeguide`, `onboarding` and `costar` or `fixture`, and carries the metadata `run_id` (the same id as the `run_id` in the API response and, with Supabase, the `agent_runs` row) and `property_id`. To find a run, filter by tag or search the metadata for its `run_id`.

On serverless hosts (Vercel), the function can be frozen as soon as the response is sent, which would drop the last trace batches. So `runOnboarding` calls `awaitAllCallbacks()` before it returns, on success and failure alike, with a 10 s cap so a slow LangSmith can't stall the response. Don't set `LANGCHAIN_CALLBACKS_BACKGROUND`: the flush already covers it, and setting it to `false` makes every agent step wait on LangSmith.

Only the agent's own inputs and outputs are sent: the prompt, tool arguments and results, and the run labels above. API keys stay out of the trace because LangChain masks model secrets and the Matterport, Vexcel and Supabase credentials are only used inside tool code. To hide payloads entirely, also set `LANGSMITH_HIDE_INPUTS=true` and `LANGSMITH_HIDE_OUTPUTS=true`. Only the onboarding agent is traced. The shopper agent doesn't use LangChain.

### Supabase setup

1. Create a project and copy its URL and anon key into `.env.local`.
2. In the SQL editor, run `supabase/migrations/001_init.sql`, then `002_tracks.sql` through `006_rls_recursion_fix.sql` in order, then `supabase/seed.sql`. `npm run test:db` applies all of them to a throwaway Postgres in Docker and runs `supabase/tests/`; without Docker, point it at any Postgres 16 with `TEST_DB_URL=postgres://postgres@localhost:5432/postgres npm run test:db` (it creates and drops a scratch `sg_db_test` database).
3. Create a staff user (Auth → Users), then run `insert into store_staff (store_id, user_id) values ('demo-store', '<user uuid>');`

Once `NEXT_PUBLIC_SUPABASE_URL` is set, the app reads from Supabase instead of the in-memory seed.

### Layout

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
