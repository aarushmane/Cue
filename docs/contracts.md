# StoreGuide contracts

Frozen at hour 2. Changing anything here needs agreement from everyone it affects. TypeScript source of truth: `lib/types.ts`.

## Owners

| Builder | Owns | Files |
|---|---|---|
| A, Business UI | Map editor, uploads, review, inventory, activity | `app/business/**`, `components/business/**`, `components/map/**` |
| B, Backend | Schema, RLS, auth, API routes, audit, seed, vision calls | `supabase/**`, `app/api/**`, `lib/db/**`, `lib/vision/**`, `lib/auth/**` |
| C, Navigation | Routing, search, landmark matching logic, shopper state machine | `lib/routing/**`, `lib/search/**`, `lib/localization/**` |
| D, Shopper UX | Voice in/out, accessible shopper pages, demo QA | `app/shopper/**`, `components/shopper/**`, `lib/speech/**` |

## IDs (demo store)

- Store `demo-store`, published map `map-demo-v1` (version 1). Store is 30 m × 20 m.
- Nodes `N01`–`N17`. `N01` entrance, `N05` help desk, `N02`–`N04` front of walkways 1–3, `N06`–`N08` back corridor, `N09`–`N17` shelf approaches (walkway 1: N09–N11, walkway 2: N12–N14, walkway 3: N15–N17, ordered front→back).
- Shelves `S-A{aisle}-{section}`, aisles 1–4, sections 1 (front) to 3 (back). A1→W1, A2→W2, A3 and A4→W3.
- Landmarks `L01`–`L05` at N01–N05. Reference photos go in `public/demo/landmarks/L0x.jpg` (take them in the real demo room).
- Products `P01`–`P22`. Almond milk is deliberately ambiguous: `P06` Silk 64 oz and `P07` Almond Breeze 32 oz.

Coordinates are normalized to 0..1 with the origin at the top-left of the floor plan and y increasing downward. Meters = `x * width_m`, `y * height_m`.

## Shared enums

```
NodeKind:            entrance | junction | aisle_marker | shelf_approach | service
ShelfLevel:          top | upper | middle | lower | bottom
Observation review:  NEEDS_REVIEW | ACCEPTED | EDITED | REJECTED | NEEDS_RESCAN   (NEEDS_RESCAN: proposed, see below)
Location status:     PUBLISHED | SUPERSEDED
Localization:        CONFIRMED | LIKELY | UNKNOWN
Navigation state:    SEARCHING | DESTINATION_SELECTED | LOCATING | ROUTING | GUIDING | ARRIVED | NEEDS_HELP
Route status:        OK | ALREADY_THERE | ROUTE_UNAVAILABLE | PRODUCT_NOT_PUBLISHED | START_NODE_INVALID
```

## API

Requests and responses use JSON with snake_case fields. TypeScript domain objects inside responses use camelCase, matching `lib/types.ts`.
✅ = implemented.

### ✅ `GET /api/stores`
`{ stores: [{ id, name, address, latitude, longitude }] }`

### ✅ `GET /api/products?store_id=&query=`
Searches published inventory only.
```json
{
  "resolution": { "status": "MATCH", "product_id": "P10" }
              | { "status": "AMBIGUOUS", "product_ids": ["P06", "P07"] }
              | { "status": "NO_MATCH" },
  "results": [{ "product": PublishedProduct, "score": 100, "spoken": "Silk Unsweetened Almond Milk, 64 oz" }]
}
```
Shopper UI rule: `MATCH` goes straight to locating. `AMBIGUOUS` reads the `spoken` options aloud and asks the shopper to choose. `NO_MATCH` asks the shopper to rephrase.

### ✅ `POST /api/routes`
Request: `{ "store_id": "demo-store", "start_node_id": "N01", "product_id": "P06", "map_version": 1 }`
Response 200:
```json
{ "status": "OK", "path": ["N01","N02","N03","N12"], "destinationShelfId": "S-A2-1", "totalDistanceM": 16.6,
  "steps": [{ "index": 0, "fromNodeId": "N01", "toNodeId": "N03", "distanceM": 13.2, "text": "Head toward …" }],
  "mapVersion": 1, "map_was_updated": false }
```
`ALREADY_THERE` returns 200. `START_NODE_INVALID` returns 400. `ROUTE_UNAVAILABLE` and `PRODUCT_NOT_PUBLISHED` return 404 with `{ status, reason }`.
The last step is always the arrival sentence. Each request re-reads the product's location, so a staff move takes effect on the next request.

### `POST /api/localize` (C logic, B route)
Request: multipart `store_id`, optional `previous_node_id`, optional `lat` and `lng`, and 1–3 `frames` (JPEG ≤ 1 MB each).
Response: `{ "confidence_state": "CONFIRMED|LIKELY|UNKNOWN", "selected_node_id": "N03" | null, "candidate_node_ids": [], "landmark_id": "L03" | null, "evidence": "…" }`
Return `selected_node_id` only when the state is `CONFIRMED` or `LIKELY`. Frames are not stored.

### `POST /api/media` (staff)
Multipart `store_id`, `shelf_id`, and `file`. Returns `{ media_id, url }`. Video frames are extracted on the client and each frame is posted as an image with `kind=video_frame`.

### `POST /api/vision/recognize` (staff)
`{ media_id }` → `{ observations: [{ id, candidate: { name, brand|null, size|null, variant|null, evidence, confidence: "high|medium|low" }, review_status: "NEEDS_REVIEW" }] }`

### `POST /api/observations/:id/review` (staff)
`{ action: "accept"|"edit"|"reject", product_id?: string, new_product?: {name,brand,variant,size,aliases}, shelf_id, level }`
`accept` and `edit` call `move_product(...)`, which writes the location and the audit event in one transaction.

**Proposed v4 extension (design handoff; not yet implemented as a route).** The v4 Review screen also sends
`action: "rescan"` with a required `reason` (≥ 5 characters). Expected behavior:

- Sets `review_status = 'NEEDS_RESCAN'`, stores the reason, the reviewer and `reviewed_at`, and writes an audit event.
- Inventory and product locations are **not** changed (same as `reject`).
- A `NEEDS_RESCAN` observation leaves the Pending queue, is never used for search or directions, and cannot be
  approved, rejected or rescanned again (409, like any non-`NEEDS_REVIEW` status). New evidence arrives as a new
  observation (or as an added sighting of a pending one).
- Server order for every action: staff authorized for the observation's store (403) → still `NEEDS_REVIEW` (409) →
  observation `version` matches (409) → re-run `validate()` for publish (422 with failing labels) → merge target
  `version` matches (409) → one transaction.

Until this route exists, the UI calls the in-memory demo adapter in `lib/demo/adapter.ts`
(`reviewObservationDemo`), which implements this order against `lib/db/demoState.ts` and is labelled
"Demo action" on screen. The database change it needs is drafted, **not applied**, in
`docs/proposals/002_needs_rescan.sql`.

### `PATCH /api/products/:id/location` (staff)
`{ shelf_id, level }` → `{ location }`. Uses the `move_product` SQL function. Requests without staff auth get 401 or 403 (test P01).

### `PUT /api/maps/:id/graph` (staff)
`{ nodes: MapNode[], edges: MapEdge[], shelves: Shelf[] }`. Only drafts can be edited. Publishing creates a new version and marks the old one `SUPERSEDED`.

### `POST /api/speech`
`{ text }` → `audio/mpeg`, or 503 when ElevenLabs isn't configured. The client then falls back to `speechSynthesis`.

### `GET /api/audit?store_id=` (staff)
`{ events: [{ id, actor_label, action, entity, entity_id, old_json, new_json, created_at }] }`

## Invariants (copy into every agent prompt)

- AI suggestions never auto-publish. Only `move_product` (called after staff review or edit) creates published locations.
- Routes come only from `lib/routing` running over graph edges. Directions come only from templates.
- Left and right are stated only when derivable (after the first leg, or from a node's known `facingDeg`).
- Unknown position means no turn-by-turn guidance.
- Shopper camera frames and audio are never persisted or logged.
