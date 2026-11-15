"""LangChain tools for the navigation agent.

Each tool is a thin wrapper over deterministic code. Model data and arrow settings come from the
per-session runtime context (see context.py); the `runtime` argument is hidden from the language
model, so the model can only pass the documented string arguments.
"""

from __future__ import annotations

from typing import Any

from langchain.tools import ToolRuntime, tool

from . import arrows, routing
from .context import NavigationSession


@tool
def resolve_destination(name: str, runtime: ToolRuntime[NavigationSession]) -> dict[str, Any]:
    """Map a human-readable destination name (for example "Help desk") to its sweep ID.

    Returns status MATCH with sweep_id, or status UNKNOWN_DESTINATION with the list of
    available destination names. Never guess a sweep ID; ask the user to choose a listed name.
    """
    return routing.resolve_destination(runtime.context.model_data, name)


@tool
def plan_navigation(start_id: str, destination_id: str, runtime: ToolRuntime[NavigationSession]) -> dict[str, Any]:
    """Plan the shortest route between two sweep IDs using only declared one-way connections.

    start_id is the user's current sweep ID. destination_id is a sweep_id returned by
    resolve_destination. Returns status ROUTE (ordered sweep_ids and steps), ARRIVED,
    UNREACHABLE, UNKNOWN_START, or UNKNOWN_DESTINATION.
    """
    return routing.plan_navigation(runtime.context.model_data, start_id, destination_id).to_dict()


@tool
def create_arrow_instructions(from_sweep_id: str, to_sweep_id: str, runtime: ToolRuntime[NavigationSession]) -> dict[str, Any]:
    """Describe the arrow for one navigation step between two consecutive sweeps in a route.

    Validates that from_sweep_id declares to_sweep_id as a neighbor, then returns structured
    instructions: Matterport SDK coordinates for the arrow anchor and target, a normalized
    horizontal direction vector, and a status of STEP, FLOOR_TRANSITION, or ARRIVED. Returns
    status UNKNOWN_SWEEP or NOT_CONNECTED on invalid input. This does not draw anything.
    Use these coordinates exactly as returned; never compute or adjust them yourself.
    """
    session = runtime.context
    result = arrows.create_arrow_instructions(session.model_data, from_sweep_id, to_sweep_id, session.arrow_config)
    return result.model_dump(mode="json")


NAVIGATION_TOOLS = [resolve_destination, plan_navigation, create_arrow_instructions]
