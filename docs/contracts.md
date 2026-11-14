# StoreGuide contracts

Frozen at hour 2. Changing anything here needs agreement from everyone it affects. TypeScript source of truth: `lib/types.ts`.

## Owners

| Builder | Owns | Files |
|---|---|---|
| A, Business UI | Map editor, uploads, review, inventory, activity, "Import from digital twin" screen | `app/business/**`, `components/business/**`, `components/map/**` |
| B, Backend + onboarding agent | Schema, RLS, auth, API routes, audit, seed, vision calls, CoStar/Vexcel adapters, deepagents onboarding agent | `supabase/**`, `app/api/**`, `lib/db/**`, `lib/vision/**`, `lib/auth/**`, `lib/costar/**`, `lib/agents/onboarding/**` |
| C, Navigation | Routing, search, landmark matching, shopper state machine, Matterport sweeps → draft graph, shopper agent tools | `lib/routing/**`, `lib/search/**`, `lib/localization/**`, `lib/twin/**`, `lib/agents/shopper/tools.ts` |
| D, Shopper UX + field | Voice in/out, accessible shopper pages, shopper agent conversation, Peri business interview, demo QA | `app/shopper/**`, `components/shopper/**`, `lib/speech/**`, `lib/agents/shopper/**` (except tools.ts) |

Track strategy and submission requirements: see `docs/tracks.md`.

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
Observation review:  NEEDS_REVIEW | ACCEPTED | EDITED | REJECTED
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

### ✅ `POST /api/localize`
Request (JSON): `{ "store_id", "previous_node_id"?: string|null, "lat"?, "lng"?, "frames": ["data:image/jpeg;base64,…"] }`. Send 1–3 frames, each ≤ ~1.5 MB.
Response: `{ "confidence_state": "CONFIRMED|LIKELY|UNKNOWN", "selected_node_id": "N03" | null, "candidate_node_ids": [], "landmark_id": "L03" | null, "evidence": "…" }`
The model only names the visible landmark. `lib/vision/matchLandmark.ts#decidePosition` decides the confidence state using map adjacency to `previous_node_id`. Frames are never stored. Returns 503 with `UNKNOWN` when no AI provider key (`GEMINI_API_KEY` or `ANTHROPIC_API_KEY`) is set.
Shopper flow: call this, then pass the result as `scan` to `/api/agent/shopper`.

### `POST /api/media` (staff)
Multipart `store_id`, `shelf_id`, and `file`. Returns `{ media_id, url }`. Video frames are extracted on the client and each frame is posted as an image with `kind=video_frame`.

### `POST /api/vision/recognize` (staff)
`{ media_id }` → `{ observations: [{ id, candidate: { name, brand|null, size|null, variant|null, evidence, confidence: "high|medium|low" }, review_status: "NEEDS_REVIEW" }] }`

### `POST /api/observations/:id/review` (staff)
`{ action: "accept"|"edit"|"reject", product_id?: string, new_product?: {name,brand,variant,size,aliases}, shelf_id, level }`
`accept` and `edit` call `move_product(...)`, which writes the location and the audit event in one transaction.

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

## Agents (added for the Amazon, LangChain and CoStar tracks)

Agents can only call the tools listed below. They never write SQL, publish locations, or write directions themselves.

### ✅ Shopper agent: `POST /api/agent/shopper` (Claude tool use, direct SDK, chosen for low latency)
The server is stateless: the client keeps `nav` and `history` and sends both back each turn.
Request: `{ nav: ShopperNav, history: MessageParam[], utterance?: string, scan?: LocalizeResult }`. Start with `nav = { store_id }` and `history = []`. `ShopperNav` is defined in `lib/agents/shopper/state.ts`.
Response: `{ say, agent_text, route_text: string[], choices: string[], ui_state, nav, history }`. Speak `say` at `nav.prefs.speech_rate`. Show `choices` as buttons.
Tools (`lib/agents/shopper/tools.ts`): `search_products`, `select_product`, `get_position`, `start_route`, `next_step`, `repeat_step`, `previous_step`, `set_preferences`, `report_issue` (writes `shopper_reports` and never edits inventory), `request_help`.
Rule: on a turn that reads a route step, `say` is ONLY the verbatim `planRoute` text (the model's own words go to `agent_text` for display), because small models paraphrase directions despite being told not to. Every step re-reads the product location, so a staff move triggers "The store just updated where this item is. Rerouting."
Returns 503 `AGENT_UNAVAILABLE` without an API key. The UI must still work then: typed search, `/api/routes`, and buttons.

### ✅ Onboarding agent: `POST /api/agent/onboard` (LangChain deepagents, staff only)
Request: `{ costar_property_id }` with a staff `Authorization: Bearer` token → `{ run_id, source: "costar"|"fixture", draft_id, report, todos, graph_summary, candidates_queued, log }` (not streamed yet).
Until the real CoStar adapter exists, use `fixture-property-1`. Results are labelled `source: "fixture"`.
Plan it follows: look up the property (CoStar) → fetch the Matterport model (sweeps, floor plan, panoramas) → convert sweeps to a draft graph (`lib/twin`) → pick landmark panoramas → run the shelf-recognition subagent on panorama crops → write a draft map and NEEDS_REVIEW observations → hand off to staff review.
Output is always a DRAFT map plus NEEDS_REVIEW observations. Staff publish.

### Digital-twin import (`lib/twin`)
- Matterport sweep = node (`source: "matterport"`, `sweep_id`). Its floor position is normalized to 0..1 using the floor's bounding box.
- Sweep neighbors (or line of sight between sweeps closer than 4 m, if neighbors aren't exposed) = edge, with weight = 3D distance in meters.
- Sweep panoramas = landmark reference images.
- Vexcel aerial image of the parcel = an outdoor approach segment (parking/drop-off → entrance node), shown to staff for confirmation.
