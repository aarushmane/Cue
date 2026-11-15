"""The navigation Deep Agent.

Model and credentials come from environment variables:
  MATTERPORT_AGENT_MODEL   provider:model string (default "anthropic:claude-opus-5-5")
  ANTHROPIC_API_KEY        read by langchain-anthropic when the provider is "anthropic"

The agent is stateless with respect to navigation data. Pass a NavigationSession on every call:

    agent = build_navigation_agent()
    agent.invoke({"messages": [...]}, context=NavigationSession(model_data=...))
"""

from __future__ import annotations

import os
from typing import Any

from deepagents import create_deep_agent

from .context import NavigationSession
from .tools import NAVIGATION_TOOLS

DEFAULT_MODEL = "anthropic:claude-opus-5-5"
MODEL_ENV_VAR = "MATTERPORT_AGENT_MODEL"

SYSTEM_PROMPT = """\
You help people move through a Matterport 3D tour by stepping between sweeps (scan points).

You know nothing about this tour except what your navigation tools return. Every sweep ID,
coordinate, destination, connection and direction you mention must come from a tool result in
this conversation. If a tool says a destination is unknown or unreachable, tell the user plainly
and offer the destinations the tool listed; do not suggest a workaround route.

To guide someone:
1. Call resolve_destination with the place they named.
2. Call plan_navigation with their current sweep ID and the destination's sweep_id.
3. For each consecutive pair of sweep_ids in the route, call create_arrow_instructions.
   Arrow coordinates and directions come only from that tool; never calculate, round or adjust
   them yourself.

If the user hasn't said which sweep they are at, ask for it. Mention floor transitions (stairs or
elevator) and any arrow result with needs_floor_height=true, since that arrow can't be placed yet.
Keep the reply short: the route in plain words, then the arrow instruction results.
"""


def resolve_model(model: Any | None = None) -> Any:
    """Explicit argument wins, then MATTERPORT_AGENT_MODEL, then the default."""
    if model is not None:
        return model
    return os.environ.get(MODEL_ENV_VAR, "").strip() or DEFAULT_MODEL


def build_navigation_agent(model: Any | None = None, **kwargs: Any):
    """Create the Deep Agent. `model` may be a provider:model string or a chat model instance."""
    return create_deep_agent(
        model=resolve_model(model),
        tools=NAVIGATION_TOOLS,
        system_prompt=SYSTEM_PROMPT,
        context_schema=NavigationSession,
        name="matterport-navigation-agent",
        **kwargs,
    )
