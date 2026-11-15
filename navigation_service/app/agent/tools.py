"""LangChain tools for the Matterport navigation agent.

Tools are built per model with `build_navigation_tools(model_data)`, so the agent for one
Matterport model can only see that model's sweeps and destinations. The tools hold no state
between calls: the agent passes the user's current sweep in each plan_navigation call.

The agent should never compute routes or arrows itself; it relays what these tools return.
"""

from __future__ import annotations

from typing import Any

from langchain_core.tools import BaseTool, tool

from app.navigation import service
from app.navigation.models import ModelNavigationData


def build_navigation_tools(model_data: ModelNavigationData) -> list[BaseTool]:
    @tool
    def resolve_destination(name: str) -> dict[str, Any]:
        """Look up a destination by its human-readable name (for example "Help desk").

        Returns status MATCH with the destination's sweep_id, or status UNKNOWN_DESTINATION
        with the list of available destination names. Ask the user to pick one of those
        names instead of guessing.
        """
        return service.resolve_destination(model_data, name)

    @tool
    def plan_navigation(start_id: str, destination_id: str) -> dict[str, Any]:
        """Plan a route between two sweep IDs in this Matterport model.

        start_id is the user's current sweep ID; destination_id is a sweep_id from
        resolve_destination. Returns status ROUTE (with ordered sweep_ids and per-step arrow
        directions), ARRIVED, UNREACHABLE, UNKNOWN_START, or UNKNOWN_DESTINATION.
        Report UNREACHABLE and UNKNOWN results to the user honestly; never invent a route.
        """
        return service.plan_navigation(model_data, start_id, destination_id).to_dict()

    return [resolve_destination, plan_navigation]
