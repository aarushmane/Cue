# StoreGuide

One rectangular free-camera mesh viewer, using the supplied Matterport scan `Muo5jpq44Xk`.

```sh
npm install
npm run dev
```

Open http://localhost:3000. Click the viewer to focus, drag to look, use WASD to move, and R/F to move up/down. The camera moves continuously, including through walls; this is a geometry viewer, not validated walking navigation.

The original OBJ is untextured. Photographic panoramas are not mesh textures.

## Python backend

The separate read-only FastAPI server lives in [backend/](backend/README.md) and is
managed with uv. Run `uv sync` from `backend/`, then
`uv run uvicorn main:app --reload --host 127.0.0.1 --port 8000`.
API docs are at http://127.0.0.1:8000/docs. It reuses the existing public Supabase
configuration, with no authentication or agent endpoints in this initial version.

## Property data

Use `.env.local` for the Supabase settings in `.env.example`. The existing `stores` table already has `costar_property_id`, `matterport_model_id`, `name`, and `address`. Existing Supabase tables, records, migrations, and seed SQL are preserved.

- `POST /api/db/properties`: insert a property/scan mapping using `Authorization: Bearer <PROPERTY_WRITE_TOKEN>`. Body: `{ "property_id": "236314", "matterport_model_id": "Muo5jpq44Xk", "name": "Sample Storefront", "address": "6301–6335 Ashcroft Dr, Houston, TX" }`. Retries return the existing row without updating it.
- `/scene/236314`: read the newest saved scan for that property from Supabase and open its mesh viewer.
- `/`: open the supplied scan directly.

Run `npm run property:add-example` while the dev server is running to save the supplied property through the API. It reads the write token from the environment and does not print credentials.

## Rendering data

- `GET /api/scenes/:modelId` returns a render manifest: model ID, source revision, units, coordinate conversion, stable mesh-proxy URL, and initial camera position.
- `GET /api/scenes/:modelId/mesh` streams the original OBJ from Matterport to the browser. Expired asset links trigger one metadata refresh. Only models registered in `stores` are served.
- Matterport API credentials stay on the server. Metadata is cached for five minutes; geometry is streamed without writing assets into the project. The browser caches geometry for five minutes.
- Three.js parses the OBJ and converts Z-up to Y-up once. The camera start position is converted separately with `(x, y, z) → (x, z, -y)`. Panorama rotations are not guessed or used as mesh textures.

The existing Supabase table remains the source of property/model identities. This first renderer fetches live metadata; it does not create an ingestion-job system, duplicate the schema, or generate point clouds. A later ingestion worker can put versioned assets and raw source snapshots into object storage behind the same manifest and mesh URLs.

Validation: `npm run typecheck` and `npm run build`.

## Design system

Read [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) before frontend changes. It combines the supplied frontend guidance with shadcn/ui Radix Nova, Tailwind v4 semantic tokens, and the local primitives in `components/ui`.

Run `npm run check:ui` with the dev server running for desktop/mobile screenshots and canvas/interaction checks. It uses installed Google Chrome. The shadcn MCP is configured for Codex; component registries are defined by `components.json`.
