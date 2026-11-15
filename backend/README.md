# StoreGuide Python backend

Read-only FastAPI server alongside the existing Next.js app. Initialized with
`uv init --app`; Python 3.12 is pinned in `.python-version`. Dependencies live in
`pyproject.toml`, including the default `dev` group for pytest and Ruff.

## Start

From the repository root:

```sh
cd backend
uv sync
uv run uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

`uv sync` installs dependencies, creates/updates `uv.lock`, and manages `.venv`.
Commit the generated `uv.lock` for repeatable installs.

Interactive API docs: http://127.0.0.1:8000/docs
OpenAPI schema: http://127.0.0.1:8000/openapi.json

Run the frontend separately with `npm run dev` from the repository root.
The frontend currently continues to use its existing Next.js routes; adding this
server does not automatically redirect those requests to Python.

## Configuration

Reads the repository's `.env`, then `.env.local`; process environment variables
take priority. No need to duplicate the existing Supabase configuration:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Optional overrides: `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Leave these unset if
reusing the frontend values. The public key can be a legacy anon JWT or a newer
publishable key. `SUPABASE_SERVICE_ROLE_KEY` is never used by this server.

`BACKEND_CORS_ORIGINS` is a comma-separated list; its default allows
`http://localhost:3000` and `http://127.0.0.1:3000` to make GET requests.

Without Supabase settings, `/health` and `/docs` work; database routes and
`/health/ready` return 503. Public Supabase grants and RLS policies must allow the
requested reads. Inaccessible rows appear as empty lists or 404, as dictated by
Supabase. This server does not change database permissions or run migrations.

The database adapter uses HTTPX to make GET requests to Supabase's existing
PostgREST Data API. It does not need a separate database connection string.

## Initial routes

All routes below use GET. IDs are the existing text IDs, except `property_id`,
which is the numeric CoStar identifier used by the existing scene viewer.

| Route | Purpose |
| --- | --- |
| `/health` | Process liveness, without a database request |
| `/health/ready` | Check configuration and a small Supabase read |
| `/api/stores` | List stores; optional `q` searches names |
| `/api/stores/{store_id}` | Store details and external scan identifiers |
| `/api/properties/{property_id}` | Newest saved property-to-Matterport mapping |
| `/api/stores/{store_id}/maps` | Published maps for a store |
| `/api/maps/{map_id}` | Published map metadata |
| `/api/maps/{map_id}/nodes` | Map navigation nodes |
| `/api/maps/{map_id}/edges` | Connections between nodes |
| `/api/maps/{map_id}/shelves` | Shelf geometry and aisle/section labels |
| `/api/stores/{store_id}/products` | Publicly visible products; optional name search `q` |
| `/api/products/{product_id}` | Product details |
| `/api/products/{product_id}/location` | Current published shelf location |

List routes accept `limit` (default 50, maximum 200) and `offset` (default 0).
Responses have the shape `{ "items": [...], "limit": 50, "offset": 0 }`.
Ordering is deterministic. Increase offset by the number of returned items until
an empty page to read a complete collection, including large maps.

For example:

```sh
curl 'http://127.0.0.1:8000/api/stores?limit=10&offset=0'
curl 'http://127.0.0.1:8000/api/properties/236314'
curl 'http://127.0.0.1:8000/api/stores/STORE_ID/products?q=milk'
```

Missing resources return 404, invalid query parameters return 422, and unavailable
database access returns a sanitized 503. Map routes explicitly require published
maps; product visibility additionally depends on the existing public RLS policy.

Authentication and agent endpoints are deferred. Private staff membership, media,
observations, audit events, reports, navigation sessions, and inventory suggestions
have no endpoints in this initial public API. Next.js hosts the Showcase embed,
property lookup, and the existing token-protected property write.

## Scene drawing placeholders

- WebSocket `/ws/scenes/{scene_id}/draw`: sends `not_implemented` and closes.
- GET `/api/scenes/{scene_id}/draw/demo`: returns HTTP 501.

Both routes are placeholders with TODOs for future implementation.

## Development

Run from `backend/`:

```sh
uv run pytest
uv run ruff check .
uv run ruff format --check .
```

Tests use a mocked HTTP transport and never read or write the live database. They
cover query scoping, published filters, pagination, missing rows, error handling,
read-only routes, and CORS.

Add dependencies with `uv add PACKAGE`, or development tools with
`uv add --dev PACKAGE`. After the initial lockfile exists, `uv sync --locked`
reproduces the resolved environment.
