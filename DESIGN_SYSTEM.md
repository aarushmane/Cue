# StoreGuide design system

This file governs frontend changes. Read it together with `AGENTS.md`. The original frontend guidance supplied by the user is preserved in full at the end of this file; the project rules below describe how to apply it with shadcn/ui. An explicit user instruction takes precedence over these defaults.

## Product direction

StoreGuide is a spatial companion for blind and low-vision users. Its workspace pairs a usable scene and destination search with a voice interface. The actual scan is the visual asset. Keep its geometry legible and the scene unframed; introduce panels only when a real workflow needs them. Avoid marketing composition, decorative sections, onboarding copy, nested cards, and a separate landing screen.

Do not display instructions about styling, shortcuts, implementation, or how the app works. Accessible names, brief action tooltips, actual data, and actionable loading/error states are appropriate. Store interaction documentation in the README and accessibility descriptions.

## Implementation contract

- Use shadcn/ui **Radix Nova**, Tailwind CSS v4, React, and TypeScript. `components.json` is the registry configuration. `postcss.config.mjs` enables `@tailwindcss/postcss`.
- `components/ui/` contains the locally owned shadcn source. Import these primitives instead of writing competing buttons, tooltips, separators, or alerts. Adapt a shared primitive deliberately when a project-wide change is required.
- Semantic CSS variables in `app/globals.css` are the source of truth. Use classes such as `bg-background`, `text-foreground`, `border-border`, and `ring-ring`; do not introduce raw colors in feature components.
- Use `cn` (re-exported from `lib/utils.ts`) for conditional classes. Use class-variance-authority for shared component variants.
- Use Lucide icons. Decorative icons have `aria-hidden="true"`; icon buttons have an accessible name and an action tooltip.
- Keep domain logic outside UI primitives. The Matterport Showcase embed owns the 3D scene and its navigation; shadcn owns the interface around it. Scenes are registered locally in `lib/scenes/demo.ts`; no database connection is needed.
- Add only the components needed by a concrete workflow. Use the shadcn MCP to discover registry components and inspect examples; the CLI remains available with `npx shadcn add <component>`.

## Foundations

| Foundation | Standard |
| --- | --- |
| Color | Deep purple primary actions, golden yellow route cues, warm white surfaces, dark plum text, and soft lavender supporting surfaces. Color supplements an icon or accessible state. |
| Mode | The supplied palette is a light theme defined centrally in `:root`. The scene retains its photographed colors. |
| Typography | Locally hosted Geist Sans variable font via `next/font/local`, with system fallbacks. Monospace for IDs and measurements. No runtime font requests to third parties. |
| Type sizes | `text-label`: 12/16 px; `text-body`: 14/20 px; `text-heading`: 18/24 px. Fixed sizes with zero letter spacing. Use larger display type only for an actual hero. |
| Spacing | Tailwind's 4 px scale. Use 4/8 px within compact controls, 12/16 px between groups, and 24 px for substantial separation. |
| Shape | 4 px small, 6 px medium, 8 px large. Card and popover radii never exceed 8 px. The main scene has no decorative border or rounding. |
| Controls | Stable dimensions; 44 × 44 px for viewer icon controls and touch targets. A hover, label, or loading state must not resize the control. |
| Borders/elevation | One semantic border for separation. Small shadows for floating controls/popovers; no card treatment for whole page sections. |
| Motion | 120 ms for feedback, 180 ms for transitions. Honor reduced motion; no decorative continuous animation. |
| Scene | The scene fills the right workspace region. `--route-color` and `--route-ink` style geometry overlays; `--scene-background` provides the loading surface. |

## Supplied brand palette

The user-supplied palette overrides the generic color guidance below: deep purple `#5E3984`, golden yellow `#FCD44A`, warm white `#FFFBEF`, dark plum `#291A38`, and soft lavender `#EDE5F5`. Wisteria `#CFA3EA` supports the waveform; `#831DC6` is the focus ring. Keep these values in global tokens. The original logo is preserved in `public/brand/logo.png` and reused as the application icon.

On desktop the left panel is a fixed 320 px column (scene fills the rest). Logo and search sit at the top; directly beneath is one compact row: settings, the microphone with its ring waveform, and the items info button. There is no "Voice" heading. Below 768 px, stack the panel after the scene. Keep the UI limited to the map, search, logo, voice controls and functional settings; do not add marketing copy, product suggestions, or duplicate location labels.

The voice panel captures microphone input only after an explicit button press. The waveform is analysed locally; during an active session, PCM audio is streamed to ElevenLabs for transcription and text is sent to the configured model provider for reasoning. The application does not persist microphone recordings. The server retains the ElevenLabs master key and issues a single-use transcription token to the browser. Show the actual off/connecting/listening/thinking/speaking state and actionable errors. Ending the session, unmounting, hiding the page, or device disconnection releases tracks, the audio context, the websocket, and pending work.

Use one round microphone button with the radial waveform drawn around it. A tap starts one request: the microphone transcribes until the visitor stops speaking (or eight seconds pass with no speech), then closes. The session stays alive only for the reply, one follow-up listening turn when the agent asks a clarifying question, and spoken directions while walking; it ends on its own once nothing is left. While busy the button shows a spinner or a stop square; tapping it again ends everything (speech, movement, transcription). Escape interrupts. No wake phrase is required; a habitual “Hey Cue” is stripped from the request. There is no on/off status line in the panel header. Display only the current accepted transcript and response. During playback the same waveform displays the output analyser. See `docs/voice.md` for the loop and cancellation contract.

The info button beside the microphone opens a popover listing the products in the current scan’s catalogue, grouped by category; choosing one fills the search box. This is an explicit user request and overrides the “no product suggestions” default above.

Settings is a compact shadcn Popover, with a Select for ElevenLabs voices, a speaker icon preview, a bounded speed Slider, and Switches for voice responses and spoken directions. No account key is displayed or stored in browser preferences. A missing Voices: Read permission is reported separately from invalid credentials; published voices and direct voice IDs remain usable. Use the existing 120/180 ms feedback tokens and reduced-motion support; add no decorative continuous animations.

Wave bars represent logarithmic speech-frequency bands gated by the signal's RMS amplitude. A critically damped spring smooths each measured bar target; there are no random or canned wave animations. Stop settles the waveform into a thin muted line and highlights the stop control, while leaving the microphone connected. Mic off uses the quiet dotted baseline; a new accepted command or replay returns to measured waveform motion. Reduced-motion mode presents a simple sound-level meter instead. Shared press/focus feedback uses 120 ms transitions; the route panel enters with a short 180 ms fade/translation.

Route cues use a narrower translucent path, smaller spaced chevrons and a thin approach ring. The 3D destination pin keeps a constant on-screen size as the camera approaches. Chevrons are steady when guidance stops; their subtle directional pulse runs only during guided movement and respects reduced motion.

The visitor's manual walking drives spoken guidance without additional voice commands. In the simulation, Up/Down and W/S walk forward/backward, Left/Right turn, A/D move sideways, and dragging looks around. Manual walking is reported in pose telemetry and refreshes the route to the locked destination. Scene controls preserve pending voice searches and speech; Square, Escape and accepted voice interruptions still stop them. Arrival announcements wait for the current response to finish. Automatic spoken directions do not require the wake phrase.

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

For the scene, Matterport Showcase handles navigation (jumping between scan points, looking around, zoom). Reset view reloads the embed at the tour's start point. Fullscreen uses the browser API and reflects its current state. Keep the scene independent of panel or toolbar layout.

Use semantic HTML first. Preserve Radix keyboard navigation, focus management, and disabled behavior. Make content wrap without clipping; do not use viewport-scaled typography or negative tracking. Readable labels and clear commands take priority over compactness.

## Verification and maintenance

Follow the testing preference in `AGENTS.md`: prioritize implementation, keep verification lightweight, and do not add or run automated tests unless requested. The automated suites and their tooling have been removed. Use a targeted manual inspection or relevant type/lint/build check when it materially helps. Confirm UI changes fit the existing layout without overflow or overlapping controls.

When a dev server is needed, reuse one serving this checkout and share its URL. Document material changes to tokens, primitive variants, or interaction patterns here, preserving the supplied guidance below.

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
