# StoreGuide

A spatial companion for blind and low-vision users. Explore a scanned environment, search for products, and follow a route through the space.

## Run locally

```sh
npm install
npm run dev
```

Open http://localhost:3000. The desktop workspace has a 25% panel on the left containing search above the voice controls, and a 75% scene on the right. On narrow screens, the panel sits below the scene. The small bottom-left settings button controls ElevenLabs voice, speed, voice responses, wake-word prompting and spoken directions. Preferences persist in this browser.

Press the microphone button to start a session, then say “Hey Cue” followed by a request. ElevenLabs transcribes your microphone; Deep Agents uses the configured Gemini or Anthropic provider for scene reasoning and ElevenLabs speaks the result. The waveform follows input or output audio. No session starts before the button is pressed. “Stop”, Square and Escape always interrupt; other background speech is ignored when wake-word prompting is enabled. Spoken directions follow the latest route, position and heading.

The home scene is J&B Food Market (`UzwrJ9TbQuG`). `/scene/:propertyId` opens a scene registered in Supabase. With a Matterport SDK key, the Showcase embed supports route overlays and point-to-point navigation. Without a key, the textured 3D simulation is used, with panorama and plain embed fallbacks.

Microphone analysis and spring physics: [docs/microphone.md](docs/microphone.md).
Voice loop, cancellation, and API: [docs/voice.md](docs/voice.md).

## Configuration

Copy `.env.example` to `.env.local` and supply the services you need:

- `MATTERPORT_API_KEY`, `MATTERPORT_API_TOKEN`: scene metadata, photos, geometry, and routing.
- `NEXT_PUBLIC_MATTERPORT_SDK_KEY`: optional Showcase integration; authorize your local domain with Matterport.
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`: saved property lookup.
- `AI_PROVIDER` and the appropriate Anthropic or Gemini key: uncatalogued image searches and the wayfinding agent.
- `ELEVENLABS_API_KEY`: realtime Scribe transcription and streamed speech. The key stays on the server; the browser receives a single-use transcription token. `ELEVENLABS_VOICE_ID` and `ELEVENLABS_TTS_MODEL` optionally select the output voice/model.

Search first uses the saved catalog in `data/wayfinding/`, then falls back to visual search. The geometric planner computes routes and directions. See [wayfinding documentation](docs/wayfinding.md).

```sh
npm run wayfinding:catalog -- UzwrJ9TbQuG
```

This saves the catalog returned by the app; an existing saved/cached catalog is reused. The token-protected `POST /api/db/properties` mapping endpoint and `npm run property:add-example` remain available for property setup.

## Python backend

The separate FastAPI application is managed with uv. See [backend/README.md](backend/README.md).

```sh
cd backend
uv sync
uv run uvicorn main:app --reload --port 8000
```

## Checks

```sh
npm run typecheck
npm run build
```

Run only the checks relevant to a change. Automated test suites and test tooling have been removed; see the testing preference in `AGENTS.md`.

Brand colors, tokens, and component conventions are documented in [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md). The supplied logo is stored unchanged in `public/brand/`. Supabase migrations and the scan-processing assets in `jb_store/` are retained.
