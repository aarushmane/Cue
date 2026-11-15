# StoreGuide Python backend

FastAPI owns the voice WebSocket and scene drawing placeholders. Next serves the React interface, scan assets and geometric route planner. Scene registration and product catalogs are local files; no database is required.

## Run

From the repository root:

```sh
uv sync --project backend
npm run dev
```

The frontend runs on port 3000 and the backend on port 8000. The dev launcher reuses a running StoreGuide backend. To run only the backend:

```sh
cd backend
uv run uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

Python 3.12 is pinned in `.python-version`; `uv.lock` records dependencies.

## Configuration

Settings read the repository's `.env`, then `.env.local`. Process environment takes precedence.

- `ELEVENLABS_API_KEY`: speech and realtime transcription setup.
- `ELEVENLABS_VOICE_ID`: optional output voice; defaults to George.
- `ELEVENLABS_TTS_MODEL`: defaults to `eleven_flash_v2_5`.
- `BACKEND_CORS_ORIGINS`: allowed browser origins; defaults to localhost and 127.0.0.1 on port 3000.
- `SCENE_SERVER_URL`: Next's scene service; defaults to `http://127.0.0.1:3000`.
- `NEXT_PUBLIC_BACKEND_URL`: browser backend origin; defaults to the current hostname on port 8000. Production needs a reachable secure WebSocket URL.

The scene agent uses the Gemini or Anthropic key configured for Next.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /health` | Process liveness |
| `GET /health/ready` | Local voice configuration, without provider requests |
| `WS /ws/voice` | Voice setup, settings, scene commands, speech and cancellation |
| `WS /ws/scenes/{scene_id}/draw` | Drawing placeholder: not implemented |
| `GET /api/scenes/{scene_id}/draw/demo` | Drawing placeholder: HTTP 501 |

Interactive docs: http://127.0.0.1:8000/docs.

## Voice protocol

JSON commands have an `id`, `type` (`token`, `voices`, `speak`, `turn`, `state`, or `cancel`), and `payload`. Replies use the same id. Speech binary frames contain a four-byte little-endian request id followed by 24 kHz PCM16; a `done` message ends the stream.

The shared async HTTP client reuses provider connections. Cancellation stops the associated task and upstream stream; disconnecting cancels all session tasks. Credentials stay on the backend. Socket origins are checked against `BACKEND_CORS_ORIGINS`.

Scene commands delegate to `SCENE_SERVER_URL/api/wayfinding/voice`; geometry is not duplicated in Python. Browser audio and movement stop immediately before the socket round trip.

Keep verification lightweight, following `AGENTS.md`. Ruff is available through `uv run ruff check .` from `backend/`.

`state` updates carry current pose, normalized heading, measured speed and destination ID over the same socket at 4 Hz. They do not invoke reasoning or count toward command rate limits. Active state is ephemeral and removed on socket close. The scene agent reads it through an unguessable `/voice/state/{session_id}` connection handle. Use one worker initially; shared state or sticky routing is needed when scaling across workers.
