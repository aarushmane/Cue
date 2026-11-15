# StoreGuide

Matterport Showcase viewer for the supplied scan `Muo5jpq44Xk`, with a separate Python backend.

```sh
npm install
npm run dev
```

Open http://localhost:3000. Showcase handles looking around and jumping between scan points. The toolbar resets the tour and toggles fullscreen. The default tour does not require Supabase or server-side Matterport API credentials.

## Python backend

The separate read-only FastAPI server lives in [backend/](backend/README.md) and is
managed with uv. Run `uv sync` from `backend/`, then
`uv run uvicorn main:app --reload --host 127.0.0.1 --port 8000`.
API docs are at http://127.0.0.1:8000/docs. It reuses the existing public Supabase
configuration, with no authentication or agent endpoints in this initial version.

## Property data

Use `.env.local` for the Supabase settings in `.env.example`. The existing `stores` table already has `costar_property_id`, `matterport_model_id`, `name`, and `address`. Existing Supabase tables, records, migrations, and seed SQL are preserved.

- `POST /api/db/properties`: insert a property/scan mapping using `Authorization: Bearer <PROPERTY_WRITE_TOKEN>`. Body: `{ "property_id": "236314", "matterport_model_id": "Muo5jpq44Xk", "name": "Sample Storefront", "address": "6301–6335 Ashcroft Dr, Houston, TX" }`. Retries return the existing row without updating it.
- `/scene/236314`: read the newest saved scan for that property from Supabase and open its Showcase tour.
- `/`: open the supplied scan directly.

Run `npm run property:add-example` while the dev server is running to save the supplied property through the API. It reads the write token from the environment and does not print credentials.

## Scene rendering

`components/scene/SceneViewer.tsx` embeds `https://my.matterport.com/show/` directly. Showcase owns photographic rendering and scan-point navigation. Programmatic SDK control and semantic drawing integration are future work; the Python backend currently exposes drawing placeholders.

Validation: `npm run typecheck` and `npm run build`.

## Design system

Read [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) before frontend changes. It combines the supplied frontend guidance with shadcn/ui Radix Nova, Tailwind v4 semantic tokens, and the local primitives in `components/ui`.

Run `npm run check:ui` with the dev server running for desktop/mobile screenshots and embed/interaction checks. It uses installed Google Chrome. The shadcn MCP is configured for Codex; component registries are defined by `components.json`.
