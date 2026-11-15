"""Sweep graph and destination data model for one Matterport model.

Copied from navigation_service/app/navigation/models.py so this agent stays standalone. Keep the two in
sync until they are merged into one shared package.

Everything here is immutable (frozen dataclasses, tuples, read-only mappings) so a
loaded model can be shared safely across requests and users. There is no global
"current position" or "current route": callers pass the start sweep every time.

Coordinates are Matterport SDK world coordinates (meters). Y is up, so the
horizontal plane is X/Z.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Annotated, Mapping

from pydantic import PlainSerializer


def _plain_dict(mapping: Mapping) -> dict:
    """Serialize a read-only mapping as an ordinary dict (a copy, so the original stays untouched)."""
    return dict(mapping)


class NavigationDataError(ValueError):
    """Raised when graph or destination data is inconsistent. Data is never auto-repaired."""


@dataclass(frozen=True)
class Vector3:
    x: float
    y: float
    z: float

    def __post_init__(self) -> None:
        for axis, value in (("x", self.x), ("y", self.y), ("z", self.z)):
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
                raise NavigationDataError(f"Coordinate {axis} must be a finite number, got {value!r}")


@dataclass(frozen=True)
class FloorInfo:
    """Matches the SDK's sweep.floorInfo: an id plus the floor's sequence (0 = lowest)."""

    id: str
    sequence: int


@dataclass(frozen=True)
class Sweep:
    model_id: str
    sweep_id: str
    position: Vector3
    """SDK camera position for this sweep."""
    neighbor_ids: tuple[str, ...]
    """Outgoing connections only. A -> B does not imply B -> A."""
    puck_position: Vector3 | None = None
    """Floor puck position, only when the source data provides it."""
    floor: FloorInfo | None = None
    """None means the floor is unknown, not "same floor"."""


@dataclass(frozen=True)
class Destination:
    name: str
    sweep_id: str
    aliases: tuple[str, ...] = ()


def normalize_name(name: str) -> str:
    return " ".join(name.casefold().split())


ReadOnlySweepMap = Annotated[Mapping[str, Sweep], PlainSerializer(_plain_dict, return_type=dict[str, Sweep])]
"""Stored as a read-only MappingProxyType. LangChain serializes tool inputs (including the hidden
runtime context) with pydantic, which expects a dict for Mapping fields; this tells pydantic to
serialize the proxy as a dict instead of warning about an unexpected mappingproxy value."""


@dataclass(frozen=True)
class ModelNavigationData:
    """All sweeps and destinations for exactly one Matterport model, validated on creation."""

    model_id: str
    sweeps: ReadOnlySweepMap
    destinations: tuple[Destination, ...]
    is_sample: bool = False
    """True for made-up local test data. Sample IDs are not real Matterport IDs."""
    _name_index: Mapping[str, Destination] = field(init=False, repr=False, compare=False)

    @classmethod
    def build(
        cls,
        model_id: str,
        sweeps: list[Sweep] | tuple[Sweep, ...],
        destinations: list[Destination] | tuple[Destination, ...],
        *,
        is_sample: bool = False,
    ) -> "ModelNavigationData":
        by_id: dict[str, Sweep] = {}
        for sweep in sweeps:
            if sweep.sweep_id in by_id:
                raise NavigationDataError(f"Duplicate sweep id {sweep.sweep_id!r}")
            by_id[sweep.sweep_id] = sweep
        return cls(
            model_id=model_id,
            sweeps=MappingProxyType(by_id),
            destinations=tuple(destinations),
            is_sample=is_sample,
        )

    def __post_init__(self) -> None:
        if not self.model_id:
            raise NavigationDataError("model_id is required")
        if not isinstance(self.sweeps, MappingProxyType):
            object.__setattr__(self, "sweeps", MappingProxyType(dict(self.sweeps)))

        for key, sweep in self.sweeps.items():
            if key != sweep.sweep_id:
                raise NavigationDataError(f"Sweep stored under {key!r} has id {sweep.sweep_id!r}")
            if sweep.model_id != self.model_id:
                raise NavigationDataError(
                    f"Sweep {sweep.sweep_id!r} belongs to model {sweep.model_id!r}, not {self.model_id!r}"
                )
            if len(set(sweep.neighbor_ids)) != len(sweep.neighbor_ids):
                raise NavigationDataError(f"Sweep {sweep.sweep_id!r} lists a neighbor twice")
            for neighbor in sweep.neighbor_ids:
                if neighbor == sweep.sweep_id:
                    raise NavigationDataError(f"Sweep {sweep.sweep_id!r} lists itself as a neighbor")
                if neighbor not in self.sweeps:
                    raise NavigationDataError(
                        f"Sweep {sweep.sweep_id!r} points to unknown neighbor {neighbor!r} in model {self.model_id!r}"
                    )

        index: dict[str, Destination] = {}
        for dest in self.destinations:
            if dest.sweep_id not in self.sweeps:
                raise NavigationDataError(
                    f"Destination {dest.name!r} points to unknown sweep {dest.sweep_id!r} in model {self.model_id!r}"
                )
            for label in (dest.name, *dest.aliases):
                key = normalize_name(label)
                if not key:
                    raise NavigationDataError(f"Destination {dest.name!r} has an empty name or alias")
                if key in index and index[key] is not dest:
                    raise NavigationDataError(f"Destination name {label!r} is used twice")
                index[key] = dest
        object.__setattr__(self, "_name_index", MappingProxyType(index))

    def find_destination(self, name: str) -> Destination | None:
        return self._name_index.get(normalize_name(name))
