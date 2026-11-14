# Track strategy

One product and one demo, entered in four special tracks plus the required main track and Best Overall (automatic). No hardware or Physical AI tracks: this is a software-only build. Each track gets a specific feature it's judged on.

| Track | Enter? | What earns it | Cost | Cut by |
|---|---|---|---|---|
| **Business & Enterprise** (required main track) | ✅ | Two-sided retail ops: digital-twin onboarding, AI-assisted inventory with human review, audit log, accessible storefront | Already the core product | Never |
| **Amazon: Best Practical AI** | ✅ | Shopper agent: plans multi-step (search → disambiguate → localize → route → guide → recover), calls real tools, adapts to verbosity and speech-rate preferences | ~4 h on top of the core flow | Never: it replaces the plain voice UI |
| **Peri: Forward Deployed** | ✅ | Interview a real Princeton business or student org about how they handle customers looking for items, and use their answers in the product | ~2 h of one person's time, Saturday morning | Never: cheapest prize per hour |
| **LangChain: Best use of deepagents** | ✅ | The onboarding agent is a deepagent: planning to-do list, a shelf-recognition subagent, file workspace, long-horizon import | ~5 h (B) | Hour 22 → fall back to a plain Claude tool loop and drop this track |
| **CoStar: Inside and Out** | ✅ | Matterport sweeps → walkable graph, panoramas → landmark references, Vexcel aerial → parking-to-entrance approach, CoStar record → store identity. A property ID becomes an accessible navigation map | ~6 h (B + C) | Hour 22 → keep whatever import works and present it as a stretch |
| Best Hardware / Physical AI | ❌ | Not entering: software only | — | — |
| Best Rookie | only if eligible | Every member must be at their first hackathon | 0 | — |
| Healthcare | ❌ | Accessibility fits, but you can only choose one required track and Business & Enterprise lines up with CoStar and Peri | — | — |
| Arlequin (forensics / social) | ❌ | No fit | — | — |

## One story across all tracks

1. **Onboard (CoStar + LangChain):** staff enter a CoStar property ID. The deepagent pulls the Matterport twin and drafts the walkable graph and landmark references, then queues shelf candidates for review.
2. **Verify (Business):** staff approve candidates. Every publish lands in the audit log.
3. **Shop (Amazon):** a blind shopper says "I need almond milk". The agent asks which one, localizes from a camera scan, and reads the computed route one step at a time.
4. **Change (Business):** staff move the product, and the shopper's next instruction reroutes.
5. **Real need (Peri):** a quote from the business you interviewed, plus one change you made because of it.

For localization, demo live in the venue room, which is controlled and reliable. Show the Matterport-imported Houston/LA building on the map screen so judges can see the import worked on real data.

## Submission requirements checklist

- [ ] Devpost: main track = Business & Enterprise. Add Rookie only if every member is a first-time hacker. Do not enter Hardware.
- [ ] Peri: business name, the consulted person's name and role, and one piece of evidence (photo, screenshot, short video or direct quote). Get their consent to be named.
- [ ] Amazon: working demo, a clear target user (blind/low-vision shoppers plus store staff), basic docs (README), a pitch.
- [ ] LangChain: the repo shows `deepagents` in use. A LangSmith trace screenshot of one onboarding run.
- [ ] CoStar: name the layers used (at least 2) and include a screenshot of a twin-imported graph over the Matterport floor plan.
- [ ] Backup recording of the full 3-minute demo.

## CoStar track: what we learned from the quickstart (Nov 14)

- Judged on: use of the data 30 (combine layers, not decoration), agentic depth 30, customer usefulness 25 ("would a CoStar customer switch this on Monday?"), demo 15. Must use at least 2 of the 3 layers. Pitch angle: an accessible-navigation map becomes a listing feature for retail landlords and tenants, generated from the twin they already have.
- Keys: `/costar-keys` in the track Discord (Matterport key + token, Vexcel key, CoStar kit link + zip password). `/ask-costar` answers API questions.
- Matterport Model API is GraphQL at `api.matterport.com/api/models/graph` with basic auth. `locations` (AnchorLocation) has `position`, `floor`, `room` and `neighbors` ("recommended for navigation"), so the twin import has real edges. **Verify on the first call that the hackathon key returns `neighbors`**; if not, the import falls back to proximity edges that never cross a wall.
- Walls come as a graph (meters, same frame as panos); floor plans have origin (bottom-left, meters) and pixels per meter, so the graph can be drawn over the real plan for the CoStar screenshot.
- The ~15,000 models are mostly apartments and amenity spaces. Real retail interiors with enough scans: 337 S Broadway (CoStar 9560712, `6FNMVoyPrL1`) and 941 Towne Ave (`bP9oEnqmeie`). No grocery aisles exist in the set: demo the twin import on these, and the shopper flow on our seeded demo store.
- The CoStar kit join is untested by the track team; our kit reader is best-effort.

## Preflight

`npm run check:costar` checks the keys, the models index rows, whether the Matterport key returns `locations.neighbors` for both retail models, whether each has a georeferenced floor plan, Vexcel coverage, and LangSmith tracing. It prints a to-do list and never prints key values.

## Remaining risks

Status checked November 14, 2026. No claim below substitutes for a live provider check.

1. **Navigation neighbors: unverified with the hackathon key.** The only configured local environment found is `../Storeguide/.env.local`; it has Gemini but no Matterport key/token. Both retail model IDs are in `../Storeguide/data/models_index.csv`. The import prefers supplied neighbors; otherwise it uses proximity edges filtered against supplied walls. Metrics now report edge lengths, degree distribution, components, wall rejections and every bridge. Synthetic doorway/L-shaped-store tests pass. This does not prove a real property's graph is connected. Pitch fallback: “Edges inferred from scan positions and checked against the wall graph.” If wall data is absent, explicitly say staff must check inferred edges on site.
2. **Floor plans: unverified for both retail properties.** The API checks require Matterport credentials. The preflight checks image URL, dimensions, resolution and origin separately from the neighbors query; no floor plan means a graph-only screenshot, clearly labelled draft. Never substitute a fixture screenshot for real CoStar evidence.
3. **JavaScript eligibility: organizer confirmation pending.** LangChain officially documents the JavaScript package and `createDeepAgent`: https://docs.langchain.com/oss/javascript/deepagents/overview . That establishes SDK support, not eligibility for this particular prize. No organizer answer is present in the repository. Ask the track channel: “Our onboarding agent uses the JS deepagents package (npm) with createDeepAgent, a subagent, write_todos and file tools. Does that qualify for Best use of deepagents?” Keep JS unless organizers require Python; no Python service has been implemented.
4. **Trace screenshots: pending a LangSmith key and live run.** Installed versions: langchain 1.6.6, @langchain/core 1.4.1, deepagents 1.16.5, langsmith 0.12.0. Invoke and streaming paths share runName `onboard <property id>`, tags `storeguide`, `onboarding`, source, and metadata `run_id`, `property_id`. Both drain callbacks before returning, on success and failure (10-second cap). The explicit todo middleware restores `write_todos` for this installed deepagents version. Automated tests verify metadata/flush wiring, not delivery to LangSmith. Capture the actual run tree and plan after credentials are configured; keep project private and use screenshots unless public sharing is explicitly approved.

### Vexcel and evidence checklist

`inspect_aerial` sends the image only to the dedicated vision call. Tool results, persisted logs and RunView carry text; `RunView.aerial.notes` appears under **Approach from outside**, labelled **Needs staff confirmation**. Privacy tests cover image exclusion. Coverage for both LA properties remains unverified without Vexcel credentials. On 403, check coverage and permissions; do not claim coverage based on coordinates alone. Without imagery, staff inspect the entrance and outside approach in person.

For Devpost name each verified layer: **CoStar** property identity, **Matterport** twin/floor plan/panoramas, **Vexcel** aerial approach. Distinguish unavailable layers from ones actually demonstrated.

After keys are available:

- Run `npm run check:costar` (or `-- --strict` to fail CI for pending checks). Record output without key values in the issue.
- Onboard `9560712` and `bP9oEnqmeie`; inspect components, wall data, bridges and plan alignment. Adjust proximity limits only from those results.
- With LangSmith tracing enabled, capture `write_todos`, lookup_property → fetch_twin → inspect_aerial → build_draft_graph → propose_landmarks → task (shelf-recognizer) → save_draft. A model can skip tools; verify the actual trace rather than assuming this sequence.
- Save genuine graph-over-floor-plan and LangSmith run-tree/plan screenshots under a local evidence folder. None have been captured yet; provider keys are missing. Post issue evidence and ask the LangChain question manually when signed in to the track channels (no issue URL or Discord session was supplied).

### Conditional Python contingency (design only)

Only activate after organizers require Python. Estimate **6–9 hours plus deployment time**; decide against the track's hour-22 cutoff. TypeScript remains the source of truth.

Files: `services/onboarding/{app.py,agent.py,tools.py,requirements.txt,README.md}`; shared Next authorization/run lookup in `lib/agents/onboarding/bridge.ts`; route `app/api/internal/onboarding/[tool]/route.ts`; optional `ONBOARD_SERVICE_URL` integration in the server-side onboarding adapter. Do not expose the shared secret in client code.

FastAPI `POST /onboard {costar_property_id, store_id}` returns the existing `OnboardingResult`. A Python deepagent reuses the existing system prompt and shelf-recognizer subagent; its tools call the authenticated Next bridge. First create a run through `POST /api/internal/onboarding/runs {property_id,store_id}` → `{run_id,source}`; finish through `POST /api/internal/onboarding/runs/:run_id/finish {status,todos,report}` → `OnboardingResult`. Staff authorization stays at the public Next entry point; bridge calls require a server-only shared bearer secret and validated run/store ownership.

| POST bridge tool | Request (all include run_id) | Response |
|---|---|---|
| lookup_property | property_id | source, property or PROPERTY_NOT_FOUND |
| fetch_twin | model_id | source, floors, sweeps_with_neighbor_data, panoramas, has_floor_plan_image, entrance_candidates |
| inspect_aerial | no additional fields | source, notes, analysis, caveat (never image bytes) |
| build_draft_graph | floor_id, entrance_sweep_id | nodes, edges, edge_source, size_m, connected_parts, fully_connected, warnings, metrics |
| propose_landmarks | max | landmark_sweep_ids, with_panorama, panorama_urls |
| recognize_shelf_image | image_url, aisle | candidates_queued_for_review, sample |
| save_draft | no additional fields | draft_id, status |

Next authenticates staff and calls FastAPI server-to-server when `ONBOARD_SERVICE_URL` is set; otherwise the current JS implementation runs. Locally run Next on 3000 and uvicorn on 8000 with reciprocal server URLs and the same private secret. Persist run state with TTL in a shared store (not a process-global map on serverless); add idempotency for save_draft. Risks: cross-service auth, run isolation, duplicate writes, schema drift, retries/timeouts, lost streaming/cancellation, and secret/image leakage in traces. Plan 1 h schemas/auth, 2–3 h bridge/state, 1–2 h Python agent, 1 h UI integration, 1–2 h tests/evidence. Do not build this speculative service before the eligibility answer.
