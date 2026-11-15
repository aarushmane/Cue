"""Decision tools for the scene agent (basic version).

The tools don't do anything in the real world yet. Each call records a decision in the
per-request SceneSession, and the route returns those decisions. Swap in real effects
(speech, viewer movement) later without changing the agent.
"""

from dataclasses import dataclass, field
from typing import Any, Literal

from langchain.tools import ToolRuntime, tool


@dataclass
class SceneSession:
    """Created fresh for every request, so users never share decisions."""

    actions: list[dict[str, Any]] = field(default_factory=list)


def _record(runtime: ToolRuntime[SceneSession], action: str, **details: Any) -> str:
    runtime.context.actions.append({"action": action, **details})
    return f"ok: {action} recorded"


@tool
def speak(message: str, runtime: ToolRuntime[SceneSession]) -> str:
    """Say something to the shopper (they may be blind or low-vision, so be concrete)."""
    return _record(runtime, "speak", message=message)


@tool
def turn(
    direction: Literal["left", "right", "around"], reason: str, runtime: ToolRuntime[SceneSession]
) -> str:
    """Turn the view left, right, or around. Give a short reason based on the scene."""
    return _record(runtime, "turn", direction=direction, reason=reason)


@tool
def move_forward(reason: str, runtime: ToolRuntime[SceneSession]) -> str:
    """Move forward to the next spot. Only when the description shows the way ahead is clear."""
    return _record(runtime, "move_forward", reason=reason)


@tool
def stop(reason: str, runtime: ToolRuntime[SceneSession]) -> str:
    """Stop and wait: the goal is reached, something blocks the way, or the scene is unclear."""
    return _record(runtime, "stop", reason=reason)


SCENE_TOOLS = [speak, turn, move_forward, stop]
