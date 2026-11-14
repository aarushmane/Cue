# Handoff: StoreGuide v4 — manager + shopper mobile app

## Overview
StoreGuide guides shoppers (including blind and low-vision shoppers) to products in a store. Two mobile surfaces:
- **Store manager / employee** (`/business/*`): Home, Floor Plan (viewer + editor), Review (observation approval), More (Inventory, Activity).
- **Shopper** (`/shopper/*`): voice-first search, results, destination, help, accessibility and privacy settings, contribution consent, observation scan.

Data flow this design implements: shopper opts in → starts an observation scan → recognition proposes a product → observation saved `NEEDS_REVIEW` → employee verifies product + exact shelf → approves → verified inventory updates → product appears on the floor plan → shopper search uses it. No observation bypasses approval.

## About the design files
`prototype/StoreGuide v4.dc.html` is a **design reference built in HTML**, not production code. Open it in a browser (keep the folder structure; it needs `support.js`, `image-slot.js` and `_ds/`). The task is to **recreate it inside the existing Next.js 16 / React 19 / TypeScript / Tailwind 4 repo `aarushmane/Storeguide`**, using its patterns (`lib/types.ts`, `lib/db`, `app/api`, `lucide-react`), not to ship the HTML.

All behavior lives in the `<script data-dc-script>` block at the bottom of the HTML (a `class Component` with `renderVals()`); the markup above it is the exact layout with inline styles. Treat that script as the behavioral spec: every function named below exists there.

## Fidelity
**High-fidelity.** Colors, type, spacing, radii, copy and interaction states are final. Recreate pixel-for-pixel at a 390px-wide phone (also check 320px and 375px). The canvas chrome around the phones (turn labels `3a`/`3b`, Home A/B toggles, palette sheet `2a`) is design-review scaffolding — **do not build it**.

## Where it goes in the repo (do not create a separate app)
Repo today: `app/page.tsx`, `app/staff/inventory/{page,InventoryReview}.tsx`, `app/api/{inventory,products,routes,localize,stores,agent}`, `lib/{types,search,routing,inventory,vision,db,seed}`. Owner map in `docs/contracts.md`.

Suggested placement (adjust to the team's owner map):
```
app/business/layout.tsx              manager shell: phone-width column, bottom nav, toast, sheet host
app/business/page.tsx                Home
app/business/floor-plan/page.tsx     Floor plan viewer + editor
app/business/review/page.tsx         Observation queue + detail (absorbs app/staff/inventory/InventoryReview.tsx)
app/business/inventory/page.tsx      Inventory list + product sheet (move & publish)
app/business/activity/page.tsx       Audit log
app/business/more/page.tsx
app/shopper/page.tsx                 Search home (voice surface)
app/shopper/{results,destination,help,settings,consent,contribute}/page.tsx
components/business/*                ReviewDetail, DuplicatePanel, VerifyFields, Checklist, ReasonSheet, MergeSheet, ConfirmPublishSheet, ShelfSheet, ProductSheet
components/map/*                     FloorPlanViewer (pan/zoom/pinch), MapOverlay, MapEditorPanel, ShelfConfig
components/shopper/*                 VoiceSurface, ConsentScreen, ObservationScan, ThemeProvider
lib/review/validate.ts               validate() — shared by UI and API
lib/review/matches.ts                findMatches()
lib/map/graph.ts                     routeTo(), reachable(), mapChecks()
app/api/observations/[id]/review/route.ts   publish / reject / rescan (replaces demoReview)
app/api/maps/[id]/graph/route.ts     save draft / publish map (exists in contracts)
```
`app/staff/inventory` already approves adaptive-inventory suggestions; fold it into `/business/review` rather than keeping two review UIs. Leave `/api/inventory/suggestions` working until the new route replaces it.

## Design tokens
| Token | Hex | Use |
|---|---|---|
| lavender | `#E9E4F3` | app canvas (manager + comfortable shopper) |
| ivory | `#F7F5F0` | cards, inputs, nav bar, sheets |
| indigo | `#44337A` | primary buttons, headings, selected, focus ring |
| indigo-pressed | `#2E2257` | `:active` on primary, link hover |
| gold | `#E8B84B` | fills only (badges, entrance/help dots, pending). Never as text on light grounds |
| charcoal | `#252331` | body text, outlines of secondary-dark buttons |
| muted | `#5B5570` | secondary text (5.7:1 on lavender) |
| control border | `#776C95` | input/select/chip borders (3.9:1) |
| card border | `#D6CCE8` | 1.5px card borders |
| tint | `#DCD3EC` | selected tint, hover on outline buttons, verified shelf fill |
| map line | `#B9AED6` / `#9C90C2` | schematic paths, sheet handle |
| warn bg | `#F8EBC8` | warnings, pending tags, "needs correction" marks |
| err text | `#8A2E12` | shopper error text (comfortable) |

Shopper themes (`THEMES` in the script): comfortable (above); **high-contrast dark** bg `#121019`, surface `#1E1B2A`, text `#FFFFFF`, muted `#C9C3DA`, primary `#E8B84B` with `#121019` on it, border `#8D86A3`, err `#FF8A80`; **high-contrast light** black on white, primary `#000000`, border `#000000`, err `#9B1C1C`.

Type: **Caprasimo** 400 for manager headings (h1 28px, section h2 19–22px, sheet h2 22–24px). **Figtree** everything else; shopper headings Figtree 800. Body 15–17px; small 13–14px; tags 12–13px/700. Shopper text scales via `font-size` on the content root (17px × 1 / 1.3 / 1.6) and every shopper size is in `em` — keep that, don't use CSS zoom.

Radii: buttons/inputs/chips `999px`; cards 22–30px; sheets `32px 32px 0 0`; phone-style dialogs 32px; map shelf regions 6–8px.
Shadows: toast/dialog `0 12px 32px rgba(37,35,49,.3)`.
Focus: `outline: 3px solid #44337A; outline-offset: 3px; box-shadow: 0 0 0 7px #E8B84B` on every focusable element.
Disabled: opacity `.45`.
Icons: Lucide, stroke-width **2.75** (repo already has `lucide-react`): home, map, sparkles, menu, package, history, camera, mic, search, sliders-vertical, upload, x, chevron-right.
Touch targets: ≥44px everywhere; primary actions 52–60px tall.
`prefers-reduced-motion`: disable transitions.

## Screens — manager
Shell: lavender background, 44px status bar, scrollable `main` (padding `4px 20px 28px`, `gap 22px`), bottom nav (ivory, top border `1.5px #D6CCE8`, radius `26px 26px 0 0`, 4 equal columns, item = 56×32 pill icon + 13px label; active pill `#DCD3EC`, label indigo 800).
**Nav: Home | Floor Plan | Review | More.** Inventory and Activity live under More and highlight More. No Capture tab and no shelf-scanning UI anywhere on the manager side.

1. **Home** — "StoreGuide Demo Market", h1 "Good morning, Dana.", "Here's what needs your attention today.", demo-data pill. Cards: *Your next task* ("{n} products are waiting for review.", "New shopper observations are ready. Nothing is published until you accept it.", **Review Products**); *Manage your store floor plan.* (map icon, "Upload your plan, then mark shelves, entrances, landmarks and walkable paths.", **Open Floor Plan**); *Explore your store* mini map; *Recent changes* (3 latest audit events, See all). The prototype also has Home B (map-first) — build **Home A** unless told otherwise.
2. **Floor plan** — see "Floor plan" section below.
3. **Review** — queue with segmented *Pending (n) / Reviewed (n)*; cards show source tag (Shopper sighting = tint, AI vision = warn bg), status tag with mark (● Needs review, ✓ Approved, ✓ Approved with edits, ✕ Rejected, ↻ Rescan requested), title, `OBS-id · location`, and a "Check: missing details, no exact shelf, possible existing product." note. Detail screen described under "Approval workflow".
4. **More** — Inventory (`n products · move and publish`), Activity (`n events`), Reset demo data (prototype only).
5. **Inventory** — search (name, brand, alias), aisle filter chips, list rows (56px circular photo slot, name, brand · size, location tag). Product sheet: photo, name, ✓ PUBLISHED LOCATION card, *Move to* shelf + level selects, **Review and publish** (disabled until changed) → alertdialog "Publish this move?" From/To → publish bumps product `version`, writes audit.
6. **Activity** — append-only, newest first, expandable rows with Before / After / Evidence and, for reviews, "Original observation".

## Approval workflow (Review detail)
Header "‹ Queue", kicker `OBS-104 · SHOPPER SIGHTING`, h1 = brand + name. Live region banner for outcome states. Sections in order:
1. **Original observation** card (evidence image slot 72px, original string, evidence text, confidence + seen time).
2. **"! Possible existing product found."** (warn bg, 2px gold border) when `findMatches()` returns candidates. Copy: "Products are never merged automatically…". Each candidate: name, `id · brand · size · location`, **View product** (expands Category/Variant/Location/Verified), **Merge with this product** (toggle, indigo fill when selected). Footer button **Confirm it is a new product** (charcoal fill when selected).
3. **Verify product** fieldset: Product name (required), Brand, Product category (select, required), Size + Variant (at least one), Existing inventory match (select: *Not checked yet* / *No match: new product* / every product), checkbox "I have verified the product identity."
4. **Verify shelf location** fieldset: "Choices come from published store map v1. Approximate or unknown locations cannot be published." Aisle (incl. *Unknown or approximate*), Shelf section (filtered by aisle, label shows approach node or "not on floor plan"), Shelf level, checkbox "I have verified the exact shelf location."
5. **Checklist** "Before publishing: n to fix" / "Ready to publish" — 8 rows, each with ✓/✕ mark + "Done:"/"Needs correction:" text + fix sentence (text, not color alone).
6. Actions: **Approve and Publish** (disabled + explanation until all pass), Save details, Merge with existing, Request rescan, Reject observation.

Rules (see `setField`, `setCheck`, `validate`):
- Editing name/brand/category/size/variant/match clears the identity checkbox and shows "! Product details changed, so this confirmation was cleared." Editing aisle/shelf/level clears the location checkbox likewise. Changing aisle clears an out-of-aisle shelf.
- `validate()` checks: details complete; identity verified; checked against inventory; exact aisle+shelf+level; location verified; shelf belongs to `demo-store`; shelf is placed on the **published floor plan** with an existing approach node; status is still `NEEDS_REVIEW`.
- Matches: token overlap of brand+name vs product brand/name/aliases (≥2 shared tokens or ≥50%), plus any `suggestedMatch`. Never auto-select.
- Back to queue discards unsaved edits; **Save details** stores the draft on the observation.

Sheets (bottom-sheet pattern: backdrop `rgba(37,35,49,.45)`, ivory, handle 44×5):
- **Publish to inventory?** — demo-action tag, VERIFIED PRODUCT card, VERIFIED SHELF LOCATION card (+ aisle name, route destination node), NEW PRODUCT / UPDATE TO AN EXISTING PRODUCT summary (shows from→to if location changes), progress text "Publishing… checking authorization, revalidating and writing in one transaction.", inline error, Cancel / **Confirm and publish** (→ "Publishing…" → "Try again").
- **Reject observation** / **Request rescan** — quick-reason chips, required textarea (≥5 chars), Cancel / submit.
- **Merge with existing** — search + list (possible matches first, gold "Possible match" tag).

Server contract (replace `demoReview()` with `POST /api/observations/:id/review`, actions `publish|reject|rescan`), in this order, all-or-nothing:
1. Staff authorized for the observation's store (`lib/auth/requireStaff.ts`) → 403.
2. Status still `NEEDS_REVIEW` → 409 "already approved/rejected by …".
3. Observation `version` matches the one the client opened → 409 conflict.
4. Re-run `validate()` server-side → 422 with failing labels.
5. Merge: target product `version` matches the client's → 409 "changed by another employee".
6. One transaction: insert product or update target (fields + aliases + `version+1`), `move_product(...)` for the location, set observation status (`ACCEPTED`, or `EDITED` if any field differs from the candidate), write audit `{actor_label, employee id, created_at, old_json, new_json, original observation}`.
7. Reject/rescan: status `REJECTED` / `NEEDS_RESCAN` + reason + audit; inventory untouched.
UI outcome banners: ✓ Successfully published (+ "1 active shopper route … flagged for route revalidation" when applicable), ! Already reviewed by another employee, ✕ Observation rejected, ↻ Rescan requested, ! Publishing failed. Done state offers **Find it in shopper search**, **Show on floor plan**, **View Published Inventory**, **Back to queue**.
**Contract change needed:** add `NEEDS_RESCAN` to the observation review enum in `docs/contracts.md`, `lib/types.ts` and the `observations.review_status` check constraint.

## Floor plan
Viewer: 420px tall (≈60% of the 688px main area), radius 30, lavender bg, `touch-action:none`. Inner stage is fitted (contain) to the plan's **own aspect ratio** and transformed `translate(tx,ty) scale(z)` from origin 0 0, z ∈ [1,5]. One-pointer drag pans (6px threshold); two pointers pinch-zoom around the midpoint; − / + (×1.4) / reset buttons bottom-right (44px); badge top-left ("Demo floor plan · no plan uploaded" on warn bg, or "Uploaded plan · name"). See `fpDown/fpMove/fpUp/fpZoomAt`.

Overlays (structured data, separate from the background image):
- Shelf regions: verified products → tint fill; none → ivory; unassigned → dashed border "?"; selected → indigo with white text. Gold dashed badge with the count of pending observations.
- Nodes: entrance/help gold dots with ENTRANCE / HELP labels; walk points indigo; landmarks rotated squares (filled = verified).
- Walkable paths: dotted `#9C90C2`; route preview path solid gold, 7px.
- Legend sentence under the viewer (text, not color alone).

Modes: **View published** / **Edit draft**. Edit adds: **Upload floor plan (image or PDF)** (PDF page 1 rendered with pdf.js; image aspect read from natural size; upload starts a *blank* draft — never reuse old coordinates on a new image), tool chips *Select, + Shelf, + Entrance, + Landmark, + Walk point, Connect paths* with a hint line, a selection panel (shelf: Shelf ID + walkable approach point; point: connections with Remove; landmark: name + "I verified this landmark on site."; Delete), **Preview route** (BFS from entrances over drawn edges only), and a publish checklist (`mapChecks`: entrance exists, every region has an ID, IDs unique, every shelf has an approach point, every shelf reachable, every shelf holding verified products is placed) with **Save draft** / **Publish** → alertdialog "Publish floor plan v{n}?". Shoppers and approvals keep using the published version until publish.

Shelf sheet (view mode): Aisle · Section, `shelf id · aisle name · approach`, "✓ n verified products", "Last verified …", product rows (category · brand · size, ✓ Verified + level), "◌ n pending observations · not published" rows (dashed border, Pending tag), and **Review n pending discoveries** (opens the single observation directly, else the queue).

Text alternative: "Shelves and places (text list)" with search (shelf, aisle, or product → "Match: …"), rows with ✓ Verified / ◌ n pending tags, a places sentence (entrances, help desk, landmarks, connection count) and an "? Uncertain locations" note for pending observations without an exact shelf.

## Screens — shopper
Shell: theme bg, 44px status bar, content root `font-size: 17px × scale`, padding `4px 20px 28px`, gap `1.15em`; visually hidden `role=status aria-live=polite` region (`sLive`). Header: STOREGUIDE wordmark, store name, step label, 56px settings button (aria-label "Accessibility and privacy settings").

1. **Search home (A)** — location pill "Your location: Unknown", h1 "What can I help you find?", then the **voice surface**: one `<button>` full width, min-height 340px, radius 40, primary fill, 104px ringed mic icon, label "Tap anywhere here to speak" (1.5em/800), sub "Voice search. You can also type below.". It contains no other controls. States (`MIC`): listening (text-colored fill + 14px tint ring, "Listening…", "Tap anywhere here to stop"), processing, error, denied, unsupported. Status line below (`#mic-status`, `aria-describedby`). Then the typed form (label "Type a product", 60px input, Search), Hear Instructions / Get Help, **Help map this store**, disclaimer. Announce "Listening." on start and "Heard "…"." on result, then run the existing search. Never start recording without a tap.
2. **Results** — "‹ New search", "n matches for "q"", option cards (Option n, title, brand · size · variant, "✓ Verified: location"); focus moves to h1.
3. **Destination** — verified destination card, "! Location updated by staff." alert when the location changed since selection, Hear location, Phase 3 note, Get Help.
4. **Help** — help desk text, "This prototype cannot contact staff for you.", Hear this, Start over.
5. **Accessibility and privacy** — Contrast (3 modes), Text size (100/130/160%), App voice, Speech speed, Directions, **Product contributions (Allowed / Not allowed; neither selected until chosen)**. Choosing Not allowed ends any scan.
6. **Consent** — h1 "Contribute product information?", optional-use copy, list of the six data types, review-before-publish copy, camera-is-separate copy, **Allow Product Contributions** (primary), **Continue Without Contributing** (secondary), settings note. Decline returns to the previous screen; search keeps working.
7. **Help map this store** — status region ("Scanning: Off/On…" + camera state: not in use / asking / on / blocked / unavailable), consent line, **Start observation scan** (explicit; requests camera only now), camera preview, **Identify product in view** (one frame on demand), result card "POSSIBLE PRODUCT · …", **Submit for staff review** / **Discard**, **End scan**, submitted confirmation, data note, Get Help. Leaving the screen, ending the scan or withdrawing consent stops the camera tracks. A submission matching an existing pending observation (same brand+name+shelf) adds a sighting instead of a new record.

## State (map to the repo's types; prototype names in parentheses)
```ts
type ReviewStatus = 'NEEDS_REVIEW'|'ACCEPTED'|'EDITED'|'REJECTED'|'NEEDS_RESCAN';
interface Observation { id; source:'shopper'|'ai'; storeId; at; confidence; evidence; sightings?;
  candidate:{ name; brand; category; size; variant; aisle; shelf; level };
  suggestedMatch?; status:ReviewStatus; version:number; reviewedBy?; reviewedAt?; reason?; productId?; isNew?; saved?: ReviewDraft }
interface ReviewDraft extends Observation['candidate'] { match:''|'new'|string; targetVersion:number|null; idOk; locOk; idReset?; locReset?; obsVersion }
interface FloorPlan { version; plan:{url;name;kind:'image'|'pdf'}|null; aspect;
  nodes:{id;x;y;kind:'entrance'|'service'|'walk'|'junction'|'shelf_approach'}[]; edges:[string,string][];
  shelves:{key;id;x;y;w;h;anchor}[]; landmarks:{id;x;y;label;verified}[] }   // x,y,w,h normalized 0..1
// products gain: category, version
// shopper prefs gain: contributions: 'allowed'|'declined'|null (default null)
```
Manager UI state: `reviewId, rTab, rSheet, rReason, rMergeQ, pubPhase, pubError, drafts, maps{published,draft}, fpMode, fpTool, fpSel, fpConnectFrom, fpRoute, fpView{z,tx,ty}, fpQ`. Shopper: `sContrib, sScan, sCam, sDetect, sSubmitted`, plus existing search/voice/settings state.
Persist shopper prefs (incl. contribution choice) client-side; everything else comes from the API.

## Seed / test data
Products P01–P22 match `lib/seed/demo-store.ts` (+ `category`). Observations: OBS-104 Oatly Oatmilk (matches P09), OBS-105 Califia Oat Milk Barista Blend (similar name, genuinely new), OBS-101 Jif (size missing), OBS-102 unidentified, no shelf (invalid location), OBS-103 Chobani (already approved by another employee → 409). Demo recognition samples: Siggi's Vanilla Skyr (new, S-A2-3, no level), Califia (duplicate → sighting).
Required scenarios: oat milk merge → publish → removed from Pending → Inventory/Activity updated → found in shopper search; reject; rescan; duplicate; invalid location; repeated approval / other reviewer; server failure (prototype toggle `simulatePublishFailure`); shopper consent → scan → submit → employee approves → appears on the shelf in the floor plan → shopper search "skyr".

## Mocked in the prototype (must be real in the app or stay clearly labelled)
- `demoReview()` → `/api/observations/:id/review` + `move_product`.
- Demo recognition → existing vision pipeline (`/api/localize` products_noted, `lib/inventory/reconcile.ts`). No image upload unless the shopper consented; never continuous video.
- Map save/publish → `PUT /api/maps/:id/graph` + publish endpoint.
- All "Demo action · local demo state" labels stay until the backend is wired.

## Files
- `prototype/StoreGuide v4.dc.html` — full design + behavior (markup = layout spec, bottom script = logic spec).
- `prototype/support.js`, `prototype/image-slot.js`, `prototype/_ds/…` — needed only to open the prototype.
- `CLAUDE_CODE_PROMPT.md` — paste into Claude Code.
