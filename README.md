# StoreGuide

A spatial companion for blind and low-vision users. Explore a scanned environment, search for products, and follow a route through the space.

## Run locally

```sh
npm install
npm run dev
```

This starts React/Next on port 3000 and the FastAPI voice backend on port 8000 (or reuses an already running backend). Python 3.12 and `uv` are needed for the initial backend install. `uv sync --project backend` installs its dependencies.

Open http://localhost:3000. The desktop workspace has a 25% panel on the left containing search above the voice controls, and a 75% scene on the right. On narrow screens, the panel sits below the scene. The small bottom-left settings button controls ElevenLabs voice, speed, voice responses, wake-word prompting and spoken directions. Preferences persist in this browser.

Press the microphone button to start a session, then say “Hey Cue” followed by each request. ElevenLabs transcribes your microphone and speaks replies. Saved destinations and basic navigation controls use the deterministic planner directly; a small LangChain tool agent handles other conversation with the configured Gemini or Anthropic provider. The waveform follows input or output audio. No session starts before the button is pressed. “Stop”, Square and Escape always interrupt. With “Require Hey Cue” enabled (the default), each wake phrase opens one request; the session stays connected but ignores other room speech between requests. Searching and playback require “Hey Cue” or Stop to interrupt, even if wake-word prompting is disabled. Adjacent transcript segments are combined before a request starts. Spoken directions follow the locked destination, live position, heading and speed.

After choosing a destination, walk with Up/Down or W/S, turn with Left/Right, and look around by dragging. Spoken guidance follows your position automatically; moving does not cut off the response or require another voice command.

The home scene is J&B Food Market (`UzwrJ9TbQuG`). `/scene/:modelId` opens a model from the local registry in `lib/scenes/demo.ts`, for example `/scene/UzwrJ9TbQuG`. Add a model id and name there to enable another scan. With a Matterport SDK key, the Showcase embed supports route overlays and point-to-point navigation. Without a key, the textured 3D simulation is used, with panorama and plain embed fallbacks.

Microphone analysis and spring physics: [docs/microphone.md](docs/microphone.md).
Voice loop, cancellation, and API: [docs/voice.md](docs/voice.md).

## Configuration

Copy `.env.example` to `.env.local` and supply the services you need:

- `MATTERPORT_API_KEY`, `MATTERPORT_API_TOKEN`: scene metadata, photos, geometry, and routing.
- `NEXT_PUBLIC_MATTERPORT_SDK_KEY`: optional Showcase integration; authorize your local domain with Matterport.
- `AI_PROVIDER` and the appropriate Anthropic or Gemini key: uncatalogued image searches and the wayfinding agent.
- `ELEVENLABS_API_KEY`: realtime Scribe transcription and streamed speech. The key stays on the server; the browser receives a single-use transcription token. `ELEVENLABS_VOICE_ID` and `ELEVENLABS_TTS_MODEL` optionally select the output voice/model.

Search uses the saved catalog in `data/wayfinding/` and returns immediately when no destination matches. Ask voice to search the photos for a closer look. The geometric planner computes routes and directions. See [wayfinding documentation](docs/wayfinding.md).

```sh
npm run wayfinding:catalog -- UzwrJ9TbQuG
```

This saves the catalog returned by the app; an existing saved/cached catalog is reused. Scenes and catalogs are local files; no database connection is required.

## Python backend

FastAPI owns `/ws/voice` (voice setup, streamed speech, settings and cancellation). Next retains scan assets and deterministic scene planning; the socket delegates language/route requests to `/api/wayfinding/voice` on the Next server. See [backend/README.md](backend/README.md).

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

Brand colors, tokens, and component conventions are documented in [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md). The supplied logo is stored unchanged in `public/brand/`. Scan-processing assets are in `jb_store/`.
