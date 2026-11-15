"""Deterministic sweep-to-sweep navigation (Dijkstra over declared, directed neighbor links).

Pure functions over an immutable ModelNavigationData. No I/O, no randomness, no shared state.
Every route and every arrow comes from the graph data; nothing is invented or guessed.
"""

from __future__ import annotations

import heapq
import math
from dataclasses import asdict, dataclass
from enum import Enum
from typing import Any

from .models import ModelNavigationData, Sweep, Vector3

ZERO_LENGTH_EPSILON_M = 1e-6
"""Horizontal moves shorter than this have no meaningful arrow direction."""


class PlanStatus(str, Enum):
    ROUTE = "ROUTE"
    ARRIVED = "ARRIVED"
    UNKNOWN_START = "UNKNOWN_START"
    UNKNOWN_DESTINATION = "UNKNOWN_DESTINATION"
    UNREACHABLE = "UNREACHABLE"


class DirectionStatus(str, Enum):
    OK = "OK"
    ZERO_LENGTH = "ZERO_LENGTH"
    """Next sweep is directly above/below (or at) this one: no horizontal arrow."""


class FloorTransition(str, Enum):
    SAME_FLOOR = "SAME_FLOOR"
    FLOOR_CHANGE = "FLOOR_CHANGE"
    UNKNOWN = "UNKNOWN"
    """At least one sweep has no floor info, so we can't say."""


@dataclass(frozen=True)
class HorizontalDirection:
    """Unit vector on the SDK X/Z plane (Y is up). x**2 + z**2 == 1."""

    x: float
    z: float


@dataclass(frozen=True)
class NavigationStep:
    index: int
    from_sweep_id: str
    to_sweep_id: str
    distance_m: float
    horizontal_distance_m: float
    direction_status: DirectionStatus
    direction: HorizontalDirection | None
    floor_transition: FloorTransition
    from_floor_id: str | None
    to_floor_id: str | None
    floor_sequence_delta: int | None
    """Positive = going up, negative = going down. None unless both floors are known."""


@dataclass(frozen=True)
class NavigationPlan:
    status: PlanStatus
    model_id: str
    start_sweep_id: str
    destination_sweep_id: str
    sweep_ids: tuple[str, ...] = ()
    steps: tuple[NavigationStep, ...] = ()
    total_distance_m: float | None = None
    reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        def convert(value: Any) -> Any:
            if isinstance(value, Enum):
                return value.value
            if isinstance(value, dict):
                return {k: convert(v) for k, v in value.items()}
            if isinstance(value, (list, tuple)):
                return [convert(v) for v in value]
            return value

        return convert(asdict(self))


def horizontal_direction(origin: Vector3, target: Vector3) -> tuple[DirectionStatus, HorizontalDirection | None, float]:
    """Normalized X/Z direction from origin to target. Returns (status, direction, horizontal length)."""
    dx = target.x - origin.x
    dz = target.z - origin.z
    length = math.hypot(dx, dz)
    if length < ZERO_LENGTH_EPSILON_M:
        return DirectionStatus.ZERO_LENGTH, None, length
    return DirectionStatus.OK, HorizontalDirection(x=dx / length, z=dz / length), length


def _distance(a: Vector3, b: Vector3) -> float:
    return math.dist((a.x, a.y, a.z), (b.x, b.y, b.z))


def _floor_transition(a: Sweep, b: Sweep) -> tuple[FloorTransition, int | None]:
    if a.floor is None or b.floor is None:
        return FloorTransition.UNKNOWN, None
    if a.floor.id == b.floor.id:
        return FloorTransition.SAME_FLOOR, 0
    return FloorTransition.FLOOR_CHANGE, b.floor.sequence - a.floor.sequence


def _build_step(index: int, a: Sweep, b: Sweep) -> NavigationStep:
    status, direction, horizontal = horizontal_direction(a.position, b.position)
    transition, delta = _floor_transition(a, b)
    return NavigationStep(
        index=index,
        from_sweep_id=a.sweep_id,
        to_sweep_id=b.sweep_id,
        distance_m=_distance(a.position, b.position),
        horizontal_distance_m=horizontal,
        direction_status=status,
        direction=direction,
        floor_transition=transition,
        from_floor_id=a.floor.id if a.floor else None,
        to_floor_id=b.floor.id if b.floor else None,
        floor_sequence_delta=delta,
    )


def _shortest_path(data: ModelNavigationData, start: str, goal: str) -> tuple[list[str], float] | None:
    """Dijkstra with edge weight = 3D distance. Ties break on sweep id so results are repeatable."""
    best: dict[str, float] = {start: 0.0}
    previous: dict[str, str] = {}
    queue: list[tuple[float, str]] = [(0.0, start)]
    done: set[str] = set()

    while queue:
        cost, current = heapq.heappop(queue)
        if current in done:
            continue
        if current == goal:
            path = [goal]
            while path[-1] != start:
                path.append(previous[path[-1]])
            path.reverse()
            return path, cost
        done.add(current)
        here = data.sweeps[current]
        for neighbor_id in sorted(here.neighbor_ids):
            if neighbor_id in done:
                continue
            new_cost = cost + _distance(here.position, data.sweeps[neighbor_id].position)
            old = best.get(neighbor_id)
            if old is None or new_cost < old or (new_cost == old and current < previous[neighbor_id]):
                best[neighbor_id] = new_cost
                previous[neighbor_id] = current
                heapq.heappush(queue, (new_cost, neighbor_id))
    return None


def resolve_destination(data: ModelNavigationData, name: str) -> dict[str, Any]:
    """Exact (case/space-insensitive) match on a destination name or alias. No fuzzy guessing."""
    dest = data.find_destination(name)
    if dest is None:
        return {
            "status": PlanStatus.UNKNOWN_DESTINATION.value,
            "model_id": data.model_id,
            "query": name,
            "available_destinations": sorted(d.name for d in data.destinations),
        }
    return {
        "status": "MATCH",
        "model_id": data.model_id,
        "query": name,
        "name": dest.name,
        "sweep_id": dest.sweep_id,
        "is_sample": data.is_sample,
    }


def plan_navigation(data: ModelNavigationData, start_sweep_id: str, destination_sweep_id: str) -> NavigationPlan:
    base = dict(model_id=data.model_id, start_sweep_id=start_sweep_id, destination_sweep_id=destination_sweep_id)

    if start_sweep_id not in data.sweeps:
        return NavigationPlan(
            status=PlanStatus.UNKNOWN_START,
            reason=f"Sweep {start_sweep_id!r} is not in model {data.model_id!r}.",
            **base,
        )
    if destination_sweep_id not in data.sweeps:
        return NavigationPlan(
            status=PlanStatus.UNKNOWN_DESTINATION,
            reason=f"Sweep {destination_sweep_id!r} is not in model {data.model_id!r}.",
            **base,
        )
    if start_sweep_id == destination_sweep_id:
        return NavigationPlan(
            status=PlanStatus.ARRIVED, sweep_ids=(start_sweep_id,), total_distance_m=0.0, **base
        )

    found = _shortest_path(data, start_sweep_id, destination_sweep_id)
    if found is None:
        return NavigationPlan(
            status=PlanStatus.UNREACHABLE,
            reason="No path follows the declared one-way neighbor connections to that sweep.",
            **base,
        )

    path, total = found
    steps = tuple(_build_step(i, data.sweeps[a], data.sweeps[b]) for i, (a, b) in enumerate(zip(path, path[1:])))
    return NavigationPlan(
        status=PlanStatus.ROUTE, sweep_ids=tuple(path), steps=steps, total_distance_m=total, **base
    )
