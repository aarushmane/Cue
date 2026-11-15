# Interruptible voice and scene control

The existing Next.js application hosts the first voice loop, alongside its existing TypeScript Deep Agents wayfinding tools. The separate Python scene agent remains available; this integration does not require starting a second server or creating a hosted ElevenLabs agent.

## Setup

Set a valid `ELEVENLABS_API_KEY` in `.env.local`, with realtime speech-to-text and text-to-speech permissions, and configure `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` for scene reasoning. Restart the dev server after editing environment files. `ELEVENLABS_VOICE_ID` defaults to the standard George voice; `ELEVENLABS_TTS_MODEL` defaults to `eleven_flash_v2_5`.

Click the microphone to start. By default, begin with “Hey Cue”, followed by a request. A wake phrase by itself opens an eight-second window for the next command. Common transcript spellings “hey queue” and “hey Q” are accepted. A find request draws a route; the move tool is intended for explicit movement requests. This uses a stored scan and its catalog/geometry, rather than continuous live scene vision.

Bottom-left settings selects the voice and speed, previews speech without requesting microphone access, and switches spoken responses, wake-word prompting, and automatic spoken directions. Preferences are stored locally in the browser. Account voices are fetched through `GET /api/voice/voices`; if the key lacks Voices: Read, the UI offers published standard voices and a direct voice-ID input. A permission failure on that endpoint does not establish that the key is invalid for transcription or TTS. The current key was verified with successful realtime token creation and a short TTS response; its account voice list returned `missing_permissions`.

| Control | Behavior |
| --- | --- |
| Microphone | Starts/ends the session and live transcription. |
| Square | Stops pending reasoning, output audio and simulated movement immediately; keeps listening. |
| Play | Replays the latest response during an active session. |
| Escape | Same immediate interruption as Square. |
| “Hey Cue” | A matching partial transcript interrupts and opens the next command. Background speech is ignored in this mode. |
| Start speaking, wake mode off | Local sound onset or partial transcription interrupts the previous turn. |
| “Stop”, “wait”, “pause” | Stops immediately and acknowledges without invoking an LLM. |
| “Resume” | Agent replans the saved destination from the latest position, then requests movement. |
| “Turn left/right/around” | Changes the simulated viewpoint through bounded scene commands. |

## Data flow

1. An explicit click requests one microphone stream, with echo cancellation and noise suppression. Web Audio analyses it locally for the waveform.
2. `POST /api/voice/token` exchanges the server-only master key for a single-use Scribe token. Responses are uncached, same-origin guarded and rate-limited. Authentication has not been added.
3. A same-origin AudioWorklet packs 100 ms of 16 kHz mono PCM16 per message. The official ElevenLabs SDK sends those packets over its realtime Scribe websocket. The microphone is never monitored through the speakers.
4. Scribe supplies partial transcripts and commits a segment after a 0.6 second silence threshold. An accepted committed transcript triggers `POST /api/voice/turn` with current camera/floor position, heading when available, current destination, and at most eight recent text messages. Wake gating is transcript-based; it is not an offline wake-word detector. While the session is enabled, audio still goes to ElevenLabs even when waiting for the wake phrase.
5. A Deep Agent calls the existing deterministic `find_item`, `locate_item`, and `plan_route` tools, plus `read_route`, `start_guidance`, `stop_guidance`, and `turn_view`. Navigation coordinates come from the planner. Model-generated scene commands are returned as data and applied only by the active browser turn.
6. `POST /api/voice/speech` proxies the ElevenLabs streaming TTS endpoint as 24 kHz PCM. The browser schedules short audio buffers as bytes arrive, with no more than approximately a second queued ahead. A separate output analyser drives the existing waveform while it speaks.
7. On completion, the session remains listening for the next request. During movement, a lightweight one-second poll computes the next directional cue from the latest geometric route, floor position and heading. Cues are deduplicated and spaced at least eight seconds apart; arrival can be announced immediately. This does not make extra reasoning-model calls. Disabling spoken directions or spoken responses silences these cues. No continuous vision sampling runs in the background.

## Cancellation

Every accepted new command invalidates the previous turn's `AbortSignal`. The same signal cancels the agent fetch, TTS fetch, reader and scheduled audio sources. An interrupted result cannot update the route or issue a late movement command. The server passes request cancellation into the Deep Agents invocation and checks it before returning effects. Provider work already accepted may still be billed.

With wake-word prompting disabled, the browser checks local RMS in each 100 ms packet. Two consecutive packets over the noise gate interrupt active speech/reasoning or movement; a nonempty partial transcript is another interruption path. With wake-word prompting enabled, only accepted wake/command transcripts interrupt; RMS alone cannot stop the turn. Explicit Stop remains available regardless of wake mode. These gates and transcript detection need testing against real microphones, rooms and speaker echo. There is no claim of speaker identification or a measured end-to-end latency guarantee.

The Three.js simulation stops guidance, turning and held movement keys synchronously. Matterport cancels the movement queue and calls `Camera.stop()` when supported by the connected SDK; older embeds may finish the transition already in progress. The photo fallback uses discrete scan-point jumps; interruption prevents subsequent jumps. An already applied jump is not reversed. Resuming is an explicit new request, avoiding surprise movement when someone pauses mid-sentence.

Use the browser controller for immediate interruption and execution; Deep Agents handles language and scene reasoning. LangGraph's human-in-the-loop `interrupt()` is a checkpoint/approval mechanism, distinct from stopping audio or a camera operation. Long-running tasks can later use the existing Python agent or a LangGraph worker, retaining this browser cancellation boundary.

## Verification

Automated test suites and browser test tooling were removed at the user's request. Keep verification lightweight. A manual voice check can cover microphone start/stop, “Hey Cue” interruption, voice selection and preview, muted responses, and directions while navigating. Live Gemini tool selection and a short ElevenLabs TTS call were previously checked; real microphone trials are needed to assess acoustics and wake-word recognition quality.

References: [ElevenLabs Scribe JavaScript SDK](https://elevenlabs.io/docs/eleven-api/resources/libraries/scribe-stt/javascript-scribe), [streamed speech API](https://elevenlabs.io/docs/api-reference/text-to-speech/stream), [Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview), and [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview).
