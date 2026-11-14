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

1. Does the hackathon key return `locations.neighbors`? (see above)
2. Is `deepagents` for JS/TS (`deepagents` on npm) acceptable for the LangChain prize, or do they expect the Python package? If Python is required, run the onboarding agent as a small FastAPI service.
