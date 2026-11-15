"""Hello-world Deep Agent: reads a text description of the scene and decides what to do."""

from typing import Any

from deepagents import create_deep_agent
from langchain.chat_models import init_chat_model

from app.agent.tools import SCENE_TOOLS, SceneSession
from app.config import Settings

SYSTEM_PROMPT = """\
You guide a shopper through a store, using a 3D tour of it. Each message gives you a text
description of what the view is currently looking at, and sometimes the shopper's goal.

Reason about what the description says is in the scene, then act with your tools:
speak to tell the shopper something useful, turn or move_forward to change the view, and stop
when the goal is reached, the way is blocked, or the scene is unclear.

Rely only on the description. Don't invent objects, signs, or distances it doesn't mention.
If it isn't enough to decide, stop and say what you'd need to see. Keep spoken messages short
and concrete. End with one sentence summarizing your decision.
"""


def build_scene_agent(settings: Settings, model: Any | None = None):
    """Build the agent once; it holds no per-user state (that lives in SceneSession)."""
    if model is None:
        model = init_chat_model(
            settings.agent_model, api_key=settings.anthropic_api_key.get_secret_value()
        )
    return create_deep_agent(
        model=model,
        tools=SCENE_TOOLS,
        system_prompt=SYSTEM_PROMPT,
        context_schema=SceneSession,
        name="scene-agent",
    )
