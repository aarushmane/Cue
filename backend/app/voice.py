"""One cancellable voice socket. Scene geometry stays in the existing TS planner."""

import asyncio
import json
import struct
import time
from typing import Any, Literal
from uuid import uuid4

import httpx
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field, ValidationError

router = APIRouter()
sessions: dict[str, dict[str, Any]] = {}
STANDARD_VOICES = [
    {"id": "JBFqnCBsd6RMkjVDRZzb", "name": "George"},
    {"id": "6WwXjDDEMyNmFG95zycZ", "name": "Eldrin"},
    {"id": "OZ0L6eISlOejga3XjDFt", "name": "Talia"},
]


class Command(BaseModel):
    id: int = Field(ge=1, le=2**31 - 1)
    type: Literal["token", "voices", "speak", "turn", "cancel", "state"]
    payload: dict[str, Any] = Field(default_factory=dict)


class Speech(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    voice_id: str | None = Field(default=None, pattern=r"^[a-zA-Z0-9_-]{1,80}$")
    speed: float = Field(default=1, ge=0.7, le=1.2)


class Position(BaseModel):
    x: float = Field(allow_inf_nan=False)
    y: float = Field(allow_inf_nan=False)
    z: float = Field(allow_inf_nan=False)


class Start(BaseModel):
    position: Position | None = None
    sweep_id: str | None = Field(default=None, max_length=64)


class LiveState(BaseModel):
    model_id: str = Field(pattern=r"^[a-zA-Z0-9]{11}$")
    start: Start
    heading_deg: float | None = Field(default=None, ge=-180, le=180)
    speed_mps: float = Field(default=0, ge=0, le=100)
    walking_speed_mps: float | None = Field(default=None, ge=0.4, le=1.8)
    moving: bool = False
    observed_at: int = Field(ge=0)
    current_item_id: str | None = Field(default=None, max_length=100)


@router.get("/voice/state/{session_id}")
async def live_state(session_id: str):
    """Ephemeral, unguessable connection handle used by the scene's read_position tool."""
    state = sessions.get(session_id)
    if state is None:
        raise HTTPException(404, "Voice session closed.")
    return state


@router.websocket("/ws/voice")
async def voice_socket(socket: WebSocket):
    settings = socket.app.state.settings
    origin = socket.headers.get("origin")
    allowed = {item.strip() for item in settings.cors_origins.split(",")}
    if origin and origin not in allowed:
        await socket.close(code=1008)
        return
    await socket.accept()
    session_id = uuid4().hex
    sessions[session_id] = {}
    client = socket.app.state.voice_http
    headers = {"xi-api-key": settings.elevenlabs_api_key.get_secret_value().strip()}
    tasks: dict[int, asyncio.Task] = {}
    sending = asyncio.Lock()
    window, hits = time.monotonic(), 0

    async def send(message: dict | bytes):
        async with sending:
            if isinstance(message, bytes):
                await socket.send_bytes(message)
            else:
                await socket.send_json(message)

    async def execute(command: Command):
        request_id = command.id
        try:
            if command.type == "turn":
                payload = {**command.payload, "session_id": session_id}
                state = sessions[session_id]
                if state.get("model_id") == payload.get("model_id") and state.get(
                    "observed_at", 0
                ) > payload.get("observed_at", 0):
                    payload.update(
                        {
                            key: state[key]
                            for key in ("start", "heading_deg", "speed_mps", "walking_speed_mps")
                            if key in state
                        }
                    )
                async with client.stream(
                    "POST",
                    f"{settings.scene_server_url.rstrip('/')}/api/wayfinding/voice",
                    json=payload,
                    timeout=120,
                ) as response:
                    response.raise_for_status()
                    async for line in response.aiter_lines():
                        if not line.strip():
                            continue
                        event = json.loads(line)
                        await send({**event, "id": request_id})
                        if event.get("type") in ("result", "error"):
                            return
                    raise ValueError("The scene response ended early. Please try again.")
            else:
                if not headers["xi-api-key"]:
                    raise ValueError(
                        "Set ELEVENLABS_API_KEY in .env.local, then restart the backend."
                    )
                base = "https://api.elevenlabs.io/v1"
                if command.type == "speak":
                    speech = Speech.model_validate(command.payload)
                    voice = (
                        speech.voice_id
                        or settings.elevenlabs_voice_id.strip()
                        or STANDARD_VOICES[0]["id"]
                    )
                    async with client.stream(
                        "POST",
                        f"{base}/text-to-speech/{voice}/stream",
                        params={"output_format": "pcm_24000"},
                        headers=headers,
                        json={
                            "text": speech.text,
                            "model_id": settings.elevenlabs_tts_model,
                            "voice_settings": {"speed": speech.speed},
                        },
                    ) as response:
                        response.raise_for_status()
                        # Four-byte request id + raw PCM; no base64 audio overhead.
                        async for chunk in response.aiter_bytes(chunk_size=4800):
                            await send(struct.pack("<I", request_id) + chunk)
                    await send({"id": request_id, "type": "done"})
                    return
                if command.type == "token":
                    response = await client.post(
                        f"{base}/single-use-token/realtime_scribe", headers=headers
                    )
                    response.raise_for_status()
                    data = {"token": response.json()["token"]}
                else:
                    response = await client.get(f"{base}/voices", headers=headers)
                    body = response.json()
                    if (
                        not response.is_success
                        and body.get("detail", {}).get("status") == "missing_permissions"
                    ):
                        data = {
                            "voices": STANDARD_VOICES,
                            "warning": (
                                "Enable Voices: Read on your ElevenLabs key to load account voices."
                            ),
                        }
                    else:
                        response.raise_for_status()
                        data = {
                            "voices": [
                                {"id": v["voice_id"], "name": v["name"]}
                                for v in body.get("voices", [])[:500]
                            ]
                        }
            await send({"id": request_id, "type": "result", "data": data})
        except asyncio.CancelledError:
            raise
        except (ValidationError, ValueError) as error:
            message = "Invalid voice request." if isinstance(error, ValidationError) else str(error)
            await send({"id": request_id, "type": "error", "error": message})
        except httpx.HTTPStatusError as error:
            status = error.response.status_code
            message = (
                "Voice provider rejected the key or its permissions."
                if status in (401, 403)
                else "Voice provider quota reached."
                if status == 429
                else "Could not complete the voice request. Try again."
            )
            await send({"id": request_id, "type": "error", "error": message})
        except httpx.RequestError:
            await send(
                {
                    "id": request_id,
                    "type": "error",
                    "error": "Voice service unreachable. Run npm run dev to start both servers.",
                }
            )
        except (RuntimeError, WebSocketDisconnect):
            pass
        except Exception:
            await send(
                {"id": request_id, "type": "error", "error": "Voice request failed. Try again."}
            )
        finally:
            tasks.pop(request_id, None)

    try:
        while True:
            raw = await socket.receive_text()
            if len(raw) > 1_000_000:
                await socket.close(code=1009)
                break
            try:
                command = Command.model_validate_json(raw)
            except ValidationError:
                await socket.close(code=1008)
                break
            if command.type == "cancel":
                task = tasks.get(command.id)
                if task:
                    task.cancel()
                continue
            if command.type == "state":
                try:
                    state = LiveState.model_validate(command.payload).model_dump(exclude_none=True)
                    if state["observed_at"] >= sessions[session_id].get("observed_at", 0):
                        sessions[session_id] = state
                except ValidationError:
                    pass
                continue
            now = time.monotonic()
            if now - window >= 60:
                window, hits = now, 0
            hits += 1
            if hits > 60 or len(tasks) >= 6 or command.id in tasks:
                await send(
                    {
                        "id": command.id,
                        "type": "error",
                        "error": "Too many voice requests. Wait a moment.",
                    }
                )
                continue
            tasks[command.id] = asyncio.create_task(execute(command))
    except WebSocketDisconnect:
        pass
    finally:
        sessions.pop(session_id, None)
        pending = list(tasks.values())
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
