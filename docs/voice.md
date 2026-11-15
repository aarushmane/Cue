# Interruptible voice and scene control

FastAPI owns the voice transport and ElevenLabs integration through one persistent `/ws/voice` connection. React owns microphone capture, audio playback and immediate movement interruption. Next retains the existing TypeScript scene planner and its grounded agent tools. The socket delegates scene requests to `/api/wayfinding/voice` internally; the duplicate Next voice HTTP endpoints have been removed.

## Setup

Set `ELEVENLABS_API_KEY` in `.env.local` for speech and `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` for reasoning. `npm run dev` starts both servers. Restart the backend after changing its environment settings. `NEXT_PUBLIC_BACKEND_URL` defaults to the current hostname on port 8000; `SCENE_SERVER_URL` defaults to `http://127.0.0.1:3000`. `ELEVENLABS_VOICE_ID` defaults to George and `ELEVENLABS_TTS_MODEL` to `eleven_flash_v2_5`.

Click the microphone to start. By default, begin with “Hey Cue”, followed by a request. The wake phrase activates this microphone session once; subsequent requests and interruptions do not need it again. Ending the microphone session resets activation. Scribe receives “Hey Cue” and “Cue” as keyterm hints. Transcript spellings “hey queue”, “hey Q”, “hey kew” and “hey que”, punctuation and joined “HeyCue” are accepted. If Scribe commits “Hey” separately, the next segment can complete the wake phrase within 2.5 seconds. While waiting for activation, the panel shows the actual heard transcript even when it does not match. A find request draws a route; the move tool is intended for explicit movement requests. This uses a stored scan and its catalog/geometry, rather than continuous live scene vision.

Bottom-left settings selects voice and speed, previews speech without microphone access, and switches spoken responses, wake-word prompting and spoken directions. Preferences stay in this browser. Voice lists and previews use the same backend socket. Missing Voices: Read permission falls back to published voices and direct voice IDs; it does not mean transcription or TTS is unavailable.

| Control | Behavior |
| --- | --- |
| Microphone | Starts/ends the session and live transcription. |
| Square | Stops pending reasoning, output audio and simulated movement immediately; keeps listening. |
| Play | Replays the latest response during an active session. |
| Escape | Same immediate interruption as Square. |
| “Hey Cue” | Activates the session once and interrupts pending speech or motion. Listening remains open until mic off. |
| Start speaking, session activated | A non-echo partial transcript interrupts speech, movement and pending tools. Local sound onset also interrupts work when output is not playing. |
| “Stop”, “wait”, “pause” | Stops immediately and acknowledges without invoking an LLM. |
| “Resume” | Replans directly to the saved item ID from the latest position; no destination search or model call. |
| “Turn left/right/around” | Changes the simulated viewpoint through bounded scene commands. |

## Data flow

1. An explicit click requests one microphone stream, with echo cancellation and noise suppression. Web Audio analyses it locally for the waveform.
2. A `token` command on `/ws/voice` exchanges the server-only master key for a single-use Scribe token. WebSocket origins and command rates are checked. Authentication has not been added.
3. A same-origin AudioWorklet packs 100 ms of 16 kHz mono PCM16 per message. The official ElevenLabs SDK sends those packets over its realtime Scribe websocket. The microphone is never monitored through the speakers.
4. Scribe supplies partial transcripts and commits after 0.6 seconds of silence. The browser combines adjacent commits and waits a further 1.1 seconds without a partial before submitting one complete request. Incomplete openings such as “can you find me” remain pending. Stop bypasses this delay. A `turn` includes current position, normalized heading, measured walking speed, destination ID and eight recent messages. Wake gating is transcript-based: enabled microphone audio still goes to ElevenLabs while waiting for activation.
5. Saved catalog matches, resume, direction requests, basic turns and speed adjustments bypass the LLM. Matching requires full query coverage: a named product cannot silently fall back to its category. A new destination missing from the catalog triggers one targeted photo search automatically, with exact-product verification before routing. Conversation uses a small LangChain tool agent, without Deep Agent filesystem/planning tools. Its tools read pose/route, adjust orientation, change speed, find/plan, move and stop. Progress, paths and adjustment actions stream over the same socket, and are accepted only by the active browser turn. Search/route tools memoize their results within each run instead of repeating expensive work.
6. A `speak` command streams ElevenLabs 24 kHz PCM over binary socket frames. The browser schedules buffers as bytes arrive; an output analyser drives the waveform. Commands carry request ids, so cancelled audio and late results can be discarded independently.
7. Pose telemetry streams to FastAPI four times per second; it does not invoke a model or consume the command rate limit. The `read_position` tool can fetch the latest per-connection state during a turn. While navigating, a 750 ms local loop computes cues using live floor position, heading and speed, with speed-dependent look-ahead. Cues are deduplicated and spaced at least four seconds apart. The simulation aligns before walking, pauses translation for sharp turns, and faces the locked product at arrival. Arrival is announced once walking and final turning finish. No continuous photo searches or model calls run in the background. Disabling spoken directions or responses silences cues.

## Cancellation

Every accepted command invalidates the previous turn's `AbortSignal`, stops scheduled audio locally, and sends a socket `cancel` for its request id. FastAPI cancels the associated async provider/planner task. Late results are discarded, so they cannot restart movement. Provider work already accepted may still be billed. Keeping a socket open reduces setup and centralizes cancellation; model/tool latency still determines much of the response time.

Stop leaves the microphone connected but settles the waveform into a thin muted line and highlights Square. Mic off uses a dotted baseline. A new accepted command or Replay restores measured waveform motion. These states are separate from disabling spoken responses in settings.

Before activation, only the wake phrase and explicit Stop are accepted. After activation, non-echo partials interrupt immediately. A conservative text comparison suppresses likely echoes of the recent output; local RMS interruption is disabled while output plays. These heuristics are not speaker identification and need real microphone trials across rooms and speaker setups. The commit grace period intentionally adds latency to avoid acting on unfinished sentences.

The Three.js simulation stops guidance, turning and held movement keys synchronously. Matterport cancels the movement queue and calls `Camera.stop()` when supported by the connected SDK; older embeds may finish the transition already in progress. The photo fallback uses discrete scan-point jumps; interruption prevents subsequent jumps. An already applied jump is not reversed. Resuming is an explicit new request, avoiding surprise movement when someone pauses mid-sentence.

The browser controls immediate interruption and execution; the existing scene agent handles language and grounded geometry tools. LangGraph's human-in-the-loop `interrupt()` is a checkpoint mechanism, distinct from stopping audio or camera motion.

## Verification

Automated test suites and browser test tooling were removed at the user's request. Keep verification lightweight. A manual voice check can cover microphone start/stop, “Hey Cue” interruption, voice selection and preview, muted responses, and directions while navigating. Live Gemini tool selection and a short ElevenLabs TTS call were previously checked; real microphone trials are needed to assess acoustics and wake-word recognition quality.

References: [ElevenLabs Scribe JavaScript SDK](https://elevenlabs.io/docs/eleven-api/resources/libraries/scribe-stt/javascript-scribe), [streamed speech API](https://elevenlabs.io/docs/api-reference/text-to-speech/stream), [LangChain agents](https://docs.langchain.com/oss/javascript/langchain/agents), and [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview).

## Catalog and deployment

Interactive search reads saved JSON and never builds a full catalog on demand. `npm run wayfinding:catalog -- <modelId>` explicitly prepares/saves the catalog before deployment. Voice catalog misses use one targeted photo search without starting a second agent. Photo-search misses are cached briefly to avoid immediately repeating an expensive scan.

No database is required for the current read-only application. Include `data/wayfinding/*.catalog.json` in the deployed Next server; serve large images/meshes from object storage or a CDN and keep API keys on the servers. Deploy FastAPI on a host supporting persistent WebSockets. Set `NEXT_PUBLIC_BACKEND_URL` to its HTTPS URL, `SCENE_SERVER_URL` to the Next server URL, and `BACKEND_CORS_ORIGINS` to the frontend origin. `VOICE_BACKEND_URL` optionally overrides the server-to-server pose URL. In-memory connection state belongs to its FastAPI worker; use a single worker initially or shared ephemeral state/sticky routing when scaling. A database is only needed for editable inventory, persistent sessions or user data.
