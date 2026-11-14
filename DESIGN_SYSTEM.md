# StoreGuide design system

This file governs frontend changes. Read it together with `AGENTS.md`. The original frontend guidance supplied by the user is preserved in full at the end of this file; the project rules below describe how to apply it with shadcn/ui. An explicit user instruction takes precedence over these defaults.

## Product direction

StoreGuide is a spatial inspection tool. Its first screen is the usable scene, with quiet operational controls. The actual scan is the visual asset. Keep its geometry legible and the scene unframed; introduce panels only when a real workflow needs them. Avoid marketing composition, decorative sections, onboarding copy, nested cards, and a separate landing screen.

Do not display instructions about styling, shortcuts, implementation, or how the app works. Accessible names, brief action tooltips, actual data, and actionable loading/error states are appropriate. Store interaction documentation in the README and accessibility descriptions.

## Implementation contract

- Use shadcn/ui **Radix Nova**, Tailwind CSS v4, React, and TypeScript. `components.json` is the registry configuration. `postcss.config.mjs` enables `@tailwindcss/postcss`.
- `components/ui/` contains the locally owned shadcn source. Import these primitives instead of writing competing buttons, tooltips, separators, or alerts. Adapt a shared primitive deliberately when a project-wide change is required.
- Semantic CSS variables in `app/globals.css` are the source of truth. Use classes such as `bg-background`, `text-foreground`, `border-border`, and `ring-ring`; do not introduce raw colors in feature components.
- Use `cn` (re-exported from `lib/utils.ts`) for conditional classes. Use class-variance-authority for shared component variants.
- Use Lucide icons. Decorative icons have `aria-hidden="true"`; icon buttons have an accessible name and an action tooltip.
- Keep domain logic outside UI primitives. Three.js owns rendering; shadcn owns the interface around it. Scene credentials, asset fetching, and Supabase code remain server-side.
- Add only the components needed by a concrete workflow. Use the shadcn MCP to discover registry components and inspect examples; the CLI remains available with `npx shadcn add <component>`.

## Foundations

| Foundation | Standard |
| --- | --- |
| Color | Neutral surfaces, emerald for primary action/focus/success, amber for warnings, red for failures. Color supplements an icon or accessible state. |
| Modes | Light values live in `:root`; dark overrides in `.dark`. The spatial workspace currently uses dark mode through `app/layout.tsx`. |
| Typography | System sans stack, with Inter when locally available. Monospace for IDs and measurements. No remote-font dependency. |
| Type sizes | `text-label`: 12/16 px; `text-body`: 14/20 px; `text-heading`: 18/24 px. Fixed sizes with zero letter spacing. Use larger display type only for an actual hero. |
| Spacing | Tailwind's 4 px scale. Use 4/8 px within compact controls, 12/16 px between groups, and 24 px for substantial separation. |
| Shape | 4 px small, 6 px medium, 8 px large. Card and popover radii never exceed 8 px. The main scene has no decorative border or rounding. |
| Controls | Stable dimensions; 44 × 44 px for viewer icon controls and touch targets. A hover, label, or loading state must not resize the control. |
| Borders/elevation | One semantic border for separation. Small shadows for floating controls/popovers; no card treatment for whole page sections. |
| Motion | 120 ms for feedback, 180 ms for transitions. Honor reduced motion; no decorative continuous animation. |
| Canvas | `--scene-background` and `--scene-material` are the only intentional hex tokens, because Three.js consumes them directly. Lighting values describe illumination, not UI colors. |

The full shadcn semantic contract includes `background/foreground`, `card`, `popover`, `primary`, `secondary`, `muted`, `accent`, `destructive`, `border`, `input`, `ring`, `chart-1…5`, and `sidebar` pairs. Project status tokens add `success` and `warning`. Add new tokens centrally and document their purpose here.

## Choosing controls

| User intent | Component/pattern |
| --- | --- |
| Execute a command | `Button`; prefer a familiar Lucide symbol for a tool command. |
| Explain an unfamiliar symbol | `Tooltip`, with an accessible name on the trigger. Tooltips must not be the only accessible label. |
| Separate toolbar groups | Decorative `Separator`; no extra panel nesting. |
| Report an actionable failure | `Alert` with concise failure text and a working recovery action. |
| Switch a mode | shadcn `ToggleGroup` with exclusive selection; add it when a mode exists. |
| Set a binary option | shadcn `Switch` or `Checkbox`. |
| Set a number | shadcn `Slider`, input, or stepper with a unit and bounded values. |
| Choose one of several options | shadcn `Select` or `DropdownMenu`. |
| Switch between views | shadcn `Tabs`. |
| Choose a color | A swatch with an accessible color name. |

Install future primitives from the same registry/style rather than reimplementing their accessibility. Never add a nonfunctional control just to show off the design system.

## Interaction and accessibility

Every control needs default, hover, focus-visible, active, and disabled states. Async operations need loading, success, and actionable error behavior. Reserve space for changing content. Icon buttons need accessible names; status announcements use live regions. Loading visuals respect reduced motion. Keep focus indicators visible against both light and dark surfaces.

For the scene, mouse/touch dragging changes the camera orientation; keyboard movement applies only while the canvas is focused. Blurring the canvas or window clears held movement keys. Reset view restores the initial camera pose. Fullscreen uses the browser API and reflects its current state. Keep the camera and scene independent of panel or toolbar layout.

Use semantic HTML first. Preserve Radix keyboard navigation, focus management, and disabled behavior. Make content wrap without clipping; do not use viewport-scaled typography or negative tracking. Readable labels and clear commands take priority over compactness.

## Verification and maintenance

1. Run `npm run typecheck` and `npm run build` after frontend integration changes.
2. Run `npm run check:ui` against the running app. This uses Playwright with installed Chrome, saves desktop/mobile screenshots, checks canvas pixels, movement/reset, hover tooltips, focused keyboard controls, responsive bounds, theme tokens, and a recoverable load failure.
3. Inspect the screenshots. Confirm the real asset is nonblank, correctly framed, and visually legible; check that controls do not collide or overflow. Do not accept a passing DOM check as proof of a rendered 3D scene.
4. When a dev server is needed, start it and share its actual URL. Reuse a server already serving this checkout; if its port belongs to something else, use another port.
5. Document material changes to tokens, primitive variants, or interaction patterns here. Preserve the provided guidance below when updating this file.

`npm run check:ui` defaults to `http://localhost:3000`; use `APP_URL` for another port and `UI_ARTIFACTS_DIR` for a different screenshot directory. Screenshots and generated verification output are ignored by Git.

## shadcn MCP

The `shadcn` MCP server is configured for Codex in `~/.codex/config.toml`. Project registries come from `components.json`; the default is `@shadcn`. Use the MCP for registry discovery, component examples, and the audit checklist. Component source and shared tokens remain authoritative in this repository.

## Supplied frontend guidance (preserved verbatim)

## Frontend guidance

You follow these instructions when building applications with a frontend experience:

### Build with empathy

- If working with an existing design or given a design framework in context, you pay careful attention to existing conventions and ensure that what you build is consistent with the frameworks used and design of the existing application.
- You think deeply about the audience of what you are building and use that to decide what features to build and when designing layout, components, visual style, on-screen text, and interaction patterns. Using your application should feel rich and sophisticated.
- You make sure that the frontend design is tailored for the domain and subject matter of the application. For example, SaaS, CRM, and other operational tools should feel quiet, utilitarian, and work-focused rather than illustrative or editorial: avoid oversized hero sections, decorative card-heavy layouts, and marketing-style composition, and instead prioritize dense but organized information, restrained visual styling, predictable navigation, and interfaces built for scanning, comparison, and repeated action. A game can be more illustrative, expressive, animated, and playful.
- You make sure that common workflows within the app are ergonomic, efficient, and comprehensive, so the user of your application can seamlessly navigate in and out of different views and pages in the application.

### Design instructions

- You make sure to use icons in buttons for tools, swatches for color, segmented controls for modes, toggles/checkboxes for binary settings, sliders/steppers/inputs for numeric values, menus for option sets, tabs for views, and text or icon+text buttons only for clear commands (unless otherwise specified). Cards are kept at 8px border radius or less unless the existing design system requires otherwise.
- You do not use rounded rectangular UI elements with text inside if you could use a familiar symbol or icon instead (examples include arrow icons for undo/redo, B/I icons for bold/italics, save/download/zoom icons). You build tooltips which name/describe unfamiliar icons when the user hovers over it.
- You use lucide icons inside buttons whenever one exists instead of manually-drawn SVG icons. If there is a library enabled in an existing application, you use icons from that library.
- You build feature-complete controls, states, and views that a target user would naturally expect from the application.
- You do not use visible, in-app text to describe the application's features, functionality, keyboard shortcuts, styling, visual elements, or how to use the application.
- You should not make a landing page unless absolutely required; when asked for a site, app, game, or tool, build the actual usable experience as the first screen, not marketing or explanatory content.
- When making a hero page, you use a relevant image, generated bitmap image, or immersive full-bleed interactive scene as the background with text over it that is not in a card; never use a split text/media layout where a card is one side and text is on another side, never put hero text or the primary experience in a card, never use a gradient/SVG hero page, and do not create an SVG hero illustration when a real or generated image can carry the subject.
- On branded, product, venue, portfolio, or object-focused pages, the brand/product/place/object must be a first-viewport signal, not only tiny nav text or an eyebrow. Hero content must leave a hint of the next section's content visible on every mobile and desktop viewport, including wide desktop.
- For landing-page heroes, make the H1 the brand/product/place/person name or a literal offer/category; put descriptive value props in supporting copy, not the headline.
- Websites and games must use visual assets. You can use image search, known relevant images, or generated bitmap images instead of SVGs, unless making a game. Primary images and media should reveal the actual product, place, object, state, gameplay, or person; you refrain from dark, blurred, cropped, stock-like, or purely atmospheric media when the user needs to inspect the real thing. For highly specific game assets you use custom SVG/Three.js/etc.
- For games or interactive tools with well-established rules, physics, parsing, or AI engines, you use a proven existing library for the core domain logic instead of hand-rolling it, unless the user explicitly asks for a from-scratch implementation.
- You use Three.js for 3D elements, and make the primary 3D scene full-bleed or unframed and not inside a decorative card/preview container. Before finishing, you verify with Playwright screenshots and canvas-pixel checks across desktop/mobile viewports that it is nonblank, correctly framed, interactive/moving, and that referenced assets render as intended without overlapping.
- You do not put UI cards inside other cards. Do not style page sections as floating cards. Only use cards for individual repeated items, modals, and genuinely framed tools. Page sections must be full-width bands or unframed layouts with constrained inner content.
- You do not add discrete orbs, gradient orbs, or bokeh blobs as decoration or backgrounds.
- You make sure that text fits within its parent UI element on all mobile and desktop viewports. Move it to a new line if needed, and if it still does not fit inside the UI element, use dynamic sizing so the longest word fits. Text must also not occlude preceding or subsequent content. Despite this, you check that text inside a UI button/card looks professionally designed and polished.
- Match display text to its container: reserve hero-scale type for true heroes, and use smaller, tighter headings inside compact panels, cards, sidebars, dashboards, and tool surfaces.
- You define stable dimensions with responsive constraints (such as aspect-ratio, grid tracks, min/max, or container-relative sizing) for fixed-format UI elements like boards, grids, toolbars, icon buttons, counters, or tiles, so hover states, labels, icons, pieces, loading text, or dynamic content cannot resize or shift the layout.
- You do not scale font size with viewport width. Letter spacing must be 0, not negative.
- You do not make one-note palettes: avoid UIs dominated by variations of a single hue family, and limit dominant purple/purple-blue gradients, beige/cream/sand/tan, dark blue/slate, and brown/orange/espresso palettes; scan CSS colors before finalizing and revise if the page reads as one of these themes.
- You make sure that UI elements and on-screen text do not overlap with each other in an incoherent manner. This is extremely important because overlap can lead to a jarring user experience.

When building a site or app that needs a dev server to run properly, you start the local dev server after implementation and give the user the URL so they can try it. If there's already a server on that port, you use another one. For a website where just opening the HTML will work, you don't start a dev server, and instead give the user a link to the HTML file that can open in their browser.
