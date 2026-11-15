# Wayfinding in the 3D tour

"Where are the chips?" → find the item → plan a walking route that avoids obstacles → show directions and draw arrows
over the Matterport tour.

| Step | Code | Notes |
| --- | --- | --- |
| Find by name | `lib/wayfinding/locate.ts` `findItem` | Same scoring as shopper product search; asks instead of guessing between equal matches. |
| Search the photos | `lib/wayfinding/vision.ts` `findInPhotos` | Only after an explicit photo-search request: a vision model scans each scan point's 4 horizon photos for the item, each hit is placed on the scan mesh, hits are grouped into places, and each place is checked with a cropped second look. Cached 30 min per query. |
| Product catalogue | `lib/wayfinding/catalog.ts` | Brands and products: each photo face is cut into 6 overlapping tiles, enlarged 2×, and the vision model lists the brands it can read with boxes; those are placed on the mesh and grouped per brand. Built once per scan (cached in memory and on disk for a week). |
| Aisle points | `lib/wayfinding/walkable.ts` | Walkable floor grid from the mesh (10 cm cells; blocked where anything sits 0.15–1.9 m above the floor) and extra standing points about every metre along the aisles, linked where the straight line keeps ≥ 0.24 m clearance. |
| Find from detections | `locateFromDetections` | Detections → 3D rays from scan points → mesh hit (clustered), else triangulated (≥ 2 sweeps), else the first shelf box. |
| Plan | `lib/wayfinding/plan.ts` `planRouteToItem` | Scan points + Matterport neighbour links; obstacle-checked extra edges; picks the best place to stand. |
| Describe | same, `lib/wayfinding/steps.ts` | Legs with turn text (fixed templates) in approximate steps (0.75 m each: "Turn right and walk about 4 steps."), floor arrows every 0.8 m, facing direction at the end. |
| Draw | `lib/wayfinding/screen.ts`, `components/scene/RouteOverlay.tsx` | Projects the route with the Showcase SDK camera; edge arrow when the next stretch is off screen. |
| Agent | `lib/agents/wayfinding/` | LangChain deepagents; tools wrap the steps above. The model never computes geometry. |

Ordinary typed and voice item requests use the saved catalogue, including negative answers. A missing item never automatically launches another image scan. Say “search the photos for pineapple” or, after a missing-item answer, “check the photos” to request that extra work. Explicit searches have a 20-second budget, share concurrent work, and reuse cached results; cancelling the last caller stops the downloads and provider calls. A scene request times out after 25 seconds and the browser after 30 seconds, so a slow provider cannot leave search loading indefinitely.

## Frames

All positions are in the **Matterport Model API frame**: metres, right-handed, **z up** — the frame of
`panoLocations.position` from `api.matterport.com`. Headings are degrees on the floor plane, 0° = +x,
counter-clockwise positive. The Showcase SDK uses its own frame; the browser converts with
`mpSdk.Conversion.basisChange(p, Coordinates.TO_SDK / TO_API)` (`components/scene/showcase.ts`).

## Inputs (to be supplied)

Put them in `data/wayfinding/<modelId>.json` (see `data/wayfinding/README.md`) or send them with each request.

- **items** — `{ id, name, aliases?, brand?, category?, position: {x,y,z}, floorId?, source: "staff"|"inventory"|"vision", confidence? }`.
  `position` is where the item is (on the shelf face). Put it on the face the aisle sees: an item inside a shelf box
  is still routable, but the planner cannot tell which aisle faces it and says so.
- **obstacles** — shelf/fixture footprints `{ kind: "box", minX, minY, maxX, maxY, floorId? }` and walls
  `{ kind: "wall", ax, ay, bx, by, floorId? }`. Matterport's wall graph is added automatically when the model has one
  (`Muo5jpq44Xk` has none).
- **detections** — what a vision model (or staff) saw: `{ label, detections: [{ sweep_id, face 0–5, u, v }] }` with
  `u, v` normalised in that skybox face (0,0 = top-left), or `{ sweep_id, heading_deg, elevation_deg }`. Skybox faces
  follow Matterport's convention (0 up, 1–4 horizon clockwise, 5 down) and are oriented by each pano's `rotation`.

## API

`POST /api/wayfinding/route` (deterministic, no model call) and `POST /api/wayfinding/agent` (natural language, needs an
AI provider; rate limited by `WAYFINDING_AGENT_RATE_LIMIT`). Only models registered in `stores` are served, plus the
demo scans in `lib/scenes/demo.ts` (J&B Food Market `UzwrJ9TbQuG`, which the home page opens, and Sample Storefront
`Muo5jpq44Xk`). Both have a saved catalogue in `data/wayfinding/`. A `start.position` within 35 cm of a scan or aisle
point plans from that point.

```json
{
  "model_id": "Muo5jpq44Xk",
  "query": "where are the chips",          // or "item_id"
  "start": { "sweep_id": "…", "position": { "x": 0, "y": 0, "z": 0 } },  // optional; default = first scan point
  "items": [], "obstacles": [], "detections": [],                          // optional per-request inputs
  "waypoints": [],                                                         // optional Showcase sweep graph (sent by the UI)
  "options": { "clearance_m": 0.3, "max_approach_m": 6, "arrow_spacing_m": 0.8, "smooth": true }
}
```

Response: `{ status, item, plan }` (route) or `{ reply, item, plan, tool_calls, log }` (agent). `plan.status` is `OK`,
`ALREADY_THERE`, `NO_APPROACH`, `NO_ROUTE` or `START_INVALID`; an OK plan has `waypointIds` (Showcase can step
through them), `polyline`, `standPoint`, `facingDeg`, `legs[].text`, `arrows[]` and `warnings`.

## Planning rules

- Matterport's neighbour links are trusted (the scanner was carried along them). Every edge the planner adds — from
  a free start position, proximity links when a model has no neighbour data, corner shortcuts, line of sight to the
  item — must clear walls and shelf boxes (0.3 m clearance for shortcuts). Shortcuts also stay within 1 m of the scanned path.
- The stand point is the reachable point minimising walking distance + 3 × (distance to the item beyond 1.5 m), plus
  1.5 m for an aisle point (a real photo looks better), among those within 6 m that can see it. With the mesh,
  "can see" is a ray from eye height to the item that hits nothing more than 30 cm before it. The sight line stops 5 cm short of the item, so the shelf it sits on blocks views from
  the far side.
- Showcase only stands on scan points, so `waypointIds` always lists every point walked even when the drawn line is smoothed.

## Showing it

- With `NEXT_PUBLIC_MATTERPORT_SDK_KEY` (and the site's domain allowed for that key), the tour is connected through
  the Showcase SDK: the route is drawn in the 3D view on every camera move, "Next stop" flies to the next scan point
  and turns toward the route, and the full Showcase sweep graph is sent with requests (the Model API may expose
  fewer sweeps — `Muo5jpq44Xk` returns 3).
- Without a key, the built-in 360° viewer (`components/scene/PanoViewer.tsx`) replaces the embed: it shows the scan
  points' own skybox photos (WebGL, proxied through `GET /api/wayfinding/skybox` because Matterport's signed URLs expire
  and send no CORS headers) and draws the route lying on the floor in perspective: a band from the visitor's feet to just
  short of the item, chevrons along it, a ring at the stand point and a pin on the item. Drag or arrow keys to look,
  scroll to zoom, select a floor marker to move; moving re-plans from the new point (`/route` with the item sent back).
  It can only stand where the Model API has orientation data (`GET /api/wayfinding/panos`; 3 points for `Muo5jpq44Xk`).
  The route is drawn on top of the photo, so a shelf between the visitor and the path does not hide it.
- Aisle points (no photo) are drawn from the scan mesh, coloured by projecting the real photos onto it
  (`components/scene/meshView.ts`). A photo only colours surfaces its camera saw (per-photo depth maps); holes in the
  scan show the nearest photo behind; needle-thin triangles (wire racks) are dropped. Within ~2 m of a real photo it
  looks close to a photo; deeper in the store, surfaces every camera saw at a steep angle smear. `?at=<point id>`
  opens the view at a given point.
- If the photos cannot load, the page falls back to the Showcase embed with directions and a top-down map in the panel.

## Walkable simulation (default without an SDK key)

`components/sim/SimViewer.tsx` combines Mann's first-person walkthrough (`jb_store/`) with the wayfinding layer:

- **Geometry and textures:** the model's MatterPak (official Model API bundle `mp:matterpak`), read with HTTP range
  requests (only the OBJ, MTL and textures; not the 220 MB point cloud) and packed into an indexed binary by
  `lib/sim/matterpak.ts`. Cached under the OS temp folder; ~3 s the first time per model. Served by `GET /api/sim/mesh`
  and `GET /api/sim/texture`.
- **Photo look (Mann's renderer, `jb_store/viewer/panotex.js`, ported):** if Mann's pipeline has baked photo textures
  for the model (`jb_store/data/<sid>/meta.json` → `baked`, from `bake_textures.py`), that mesh is drawn as is and **T**
  shows the original MatterPak. Otherwise the scan's 2k photos (`?pano=4k` for 4k) are projected live: per pixel, the
  photo that sees it most squarely and closest wins (weight |n·d|^1.5 / r², straight down ×0.02), occlusion from a
  distance cube map per photo, mip level matched to the pixel footprint; unseen surfaces keep the MatterPak texture,
  holes stay white. **T** switches to the plain MatterPak textures (`?tex=matterpak` to start so). Rendering is sRGB.
- **Walking:** WASD (Shift faster), drag, arrow keys or **Q/E** to look/turn, **Space/C** to raise/lower the view, scroll to zoom, **1–9** or a floor ring to jump to a
  photo spot. On touch (or mouse), double-tap steps 0.75 m forward and double-tap-hold walks forward until release,
  sliding sideways to steer; the canvas sets `touch-action: none` so the browser does not zoom. Collisions use the walkable grid from the scan mesh (`GET /api/sim/walk`, `lib/sim/walk.ts`): you stop
  22 cm from shelves and slide along them, and can always step out of a tight spot.
- **Route:** drawn in the scene as geometry on the floor (band, pulsing chevrons, stand ring), so shelves hide it; the
  item pin shows through. Off-screen, an edge arrow points the way. The band is redrawn from your feet every 5 cm you
  move (`lib/sim/livePath.ts`: the walked part disappears; a connector joins you back if you step off, never through a
  shelf), and the route is re-planned from where you are (`start.position`) every 0.25 s / 0.25 m while you walk and
  once when you stop; a failed re-plan keeps the last route. **Walk me there** follows the route to the stand point
  and turns to the item.
- **Fallbacks:** without WebGL2 or a MatterPak, the 360° photo viewer (`PanoViewer`), then the Showcase embed.
- **Search:** the search box makes one request to `/api/wayfinding/route`, using saved items and the catalogue.
  A miss returns immediately. Photo search requires an explicit voice request or `search_photos: true` in the route request.

## Photo search notes

- Checked on `Muo5jpq44Xk` ("chips"): three cold runs all placed the chips on the rack by the entrance (two within 25 cm of
  each other; one on the floor at the rack's base). Before verification was added, one run picked a pastry rack.
- Vision output varies run to run, so a place must survive the cropped yes/no check. If verification itself fails (API
  error), the place is kept at half confidence.
- One search costs one vision call per scan point (4 photos each) plus up to 4 verification calls, and takes ~30–60 s
  cold. Repeat searches are served from the cache.
- Only scan points with orientation data from the Model API can be searched (3 for this model).

- Brand, product and category questions ("takis", "dr pepper", "chips", "something to drink") are answered from the
  catalogue — `data/wayfinding/<modelId>.catalog.json` when saved, otherwise the disk/memory cache — with no AI call.
  Interactive requests never build a full catalogue. Voice requests automatically search photos once when the exact
  destination is missing from the catalogue; typed route requests can opt in with `search_photos: true`.
- `Muo5jpq44Xk` catalogue: 50 placed products, 39 brands (soda, chips, beer, cereal, noodles, detergent, snack cakes, …).
  No candy is legible from its 3 photo points, so "candy" finds nothing (the live search's guesses are rejected).
- Gemini free-tier limits are per model per day (500 for `gemini-3.1-flash-lite`). On "quota exceeded" the app moves to
  `GEMINI_FALLBACK_MODELS` (default `gemini-3.5-flash-lite`) until the limit resets, and the page answers through
  `/route` when the agent is unavailable. Vision schemas are kept free of bounds because Gemini rejects complex
  constrained schemas with "invalid argument"; ranges are clamped in code.

## Not yet verified

- The SDK path (overlay, Next stop, sweep graph) is written against the SDK 26.11 type definitions but has not run
  against a live key. The overlay takes pixels from `worldToScreen` and decides "in front of the camera" itself from
  `pose.rotation` (yaw sign picked at runtime by checking which forward direction `worldToScreen` puts at the centre).
  Still to check with a key: that SDK sweep ids match Model API ids for this model.
- Item positions and shelf boxes for the real store do not exist yet; the end-to-end checks used a labelled sample item.
