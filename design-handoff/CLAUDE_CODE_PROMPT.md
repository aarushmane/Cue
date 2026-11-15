# Prompt for Claude Code

Paste this into Claude Code from the root of the StoreGuide repo, after copying `design_handoff_storeguide_v4/` into the repo (e.g. `docs/design_handoff_storeguide_v4/`).

---

Read `docs/design_handoff_storeguide_v4/README.md` and open `docs/design_handoff_storeguide_v4/prototype/StoreGuide v4.dc.html` (markup = layout, bottom `<script data-dc-script>` = behavior). Implement this design in the existing Next.js 16 / React 19 / TypeScript / Tailwind 4 app. Do not create a separate app and do not redesign.

Rules:
- Read `docs/contracts.md`, `lib/types.ts`, `lib/seed/demo-store.ts`, `lib/search/matchProducts.ts`, `lib/inventory/*`, `app/staff/inventory/*` and `app/api/*` first. Reuse existing types, seed data, search, routing and API routes. List the files you will add or change before writing code.
- Match the prototype exactly: colors, copy, sizes, radii, states and focus ring from the README tokens. Use `lucide-react` icons at stroke-width 2.75. Load Caprasimo and Figtree with `next/font/google`.
- Skip the design-canvas scaffolding (turn labels, Home A/B toggles, palette sheet). Build manager Home A and shopper Home A.
- Put `validate()`, `findMatches()`, `routeTo()`, `reachable()` and `mapChecks()` in `lib/` and use the same functions on the client and the server.
- Replace `demoReview()` with `POST /api/observations/:id/review` following the server contract in the README (auth, status, version conflict, revalidate, one transaction via `move_product`, audit). Propose the `NEEDS_RESCAN` enum change to `docs/contracts.md`, `lib/types.ts` and the migration, and wait for my OK before you write the migration.
- Where a backend piece does not exist yet, keep the prototype's "Demo action" labels and use local state. Never fake persistence.
- Work in this order, and run `npm run typecheck`, `npm run lint` and `npm test` after each step: (1) shared lib + types, (2) manager shell, nav and Home, (3) Review workflow, (4) Inventory and Activity, (5) Floor plan viewer and editor, (6) shopper voice surface and settings, (7) consent and observation scan, (8) wire cross-screen sync and the required scenarios in the README as Playwright tests.
- Work on a new local branch `frontend/storeguide-v4`. Commit locally. **Do not push.**
