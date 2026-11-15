"""Deterministic arrow instructions for one navigation step (source sweep -> target sweep).

This module only *describes* where an arrow should go. It does not draw anything, move the
camera, or talk to the Matterport SDK. A future viewer integration reads ArrowInstruction and
renders it.

Coordinate system: Matterport SDK world coordinates, meters, Y up. The horizontal direction is
computed from the two sweeps' SDK positions on the X/Z plane.

Arrow placement rules (never guessed):
  1. If the sweep has a puck position (a point on the floor), place the arrow at
     puck + vertical_offset_m.                                  source = "PUCK"
  2. Otherwise, if ArrowConfig supplies a floor height for the sweep's floor, place it at
     (sweep x, floor_height + vertical_offset_m, sweep z).       source = "SUPPLIED_FLOOR_HEIGHT"
  3. Otherwise position is None.                                 source = "NEEDS_FLOOR_HEIGHT"
The camera height (sweep position Y) is never used as a floor height.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from enum import Enum
from types import MappingProxyType
from typing import Annotated, Literal, Mapping

from pydantic import BaseModel, ConfigDict, Field, PlainSerializer, field_validator, model_validator

from .models import ModelNavigationData, Sweep, Vector3, _plain_dict
from .routing import DirectionStatus, FloorTransition, _floor_transition, horizontal_direction

COORDINATE_SYSTEM = "MATTERPORT_SDK_WORLD"
UNIT_TOLERANCE = 1e-9


# --- configuration -------------------------------------------------------------------------


@dataclass(frozen=True)
class ArrowConfig:
    """Per-session arrow settings. Supplied by the application, never by the language model."""

    vertical_offset_m: float = 0.05
    """Lift above the floor so the arrow isn't hidden inside the floor mesh."""
    floor_heights_m: Annotated[Mapping[str, float], PlainSerializer(_plain_dict, return_type=dict[str, float])] = field(
        default_factory=dict
    )
    """Optional floor Y per floor id, used only for sweeps without a puck position.
    Stored read-only (MappingProxyType); serialized as a plain dict (see models.ReadOnlySweepMap)."""

    def __post_init__(self) -> None:
        if not math.isfinite(self.vertical_offset_m):
            raise ValueError("vertical_offset_m must be finite")
        heights = dict(self.floor_heights_m)
        for floor_id, height in heights.items():
            if not math.isfinite(height):
                raise ValueError(f"Floor height for {floor_id!r} must be finite")
        object.__setattr__(self, "floor_heights_m", MappingProxyType(heights))


# --- output schema -------------------------------------------------------------------------


class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class Point3(_Frozen):
    """A point in Matterport SDK world coordinates (meters, Y up)."""

    x: float = Field(allow_inf_nan=False)
    y: float = Field(allow_inf_nan=False)
    z: float = Field(allow_inf_nan=False)

    @classmethod
    def of(cls, v: Vector3) -> "Point3":
        return cls(x=v.x, y=v.y, z=v.z)


class Direction2D(_Frozen):
    """Unit vector on the SDK X/Z (horizontal) plane: x**2 + z**2 == 1."""

    x: float = Field(allow_inf_nan=False)
    z: float = Field(allow_inf_nan=False)

    @model_validator(mode="after")
    def _unit_length(self) -> "Direction2D":
        if abs(math.hypot(self.x, self.z) - 1.0) > UNIT_TOLERANCE:
            raise ValueError("direction must be normalized to length 1")
        return self


class PlacementSource(str, Enum):
    PUCK = "PUCK"
    SUPPLIED_FLOOR_HEIGHT = "SUPPLIED_FLOOR_HEIGHT"
    NEEDS_FLOOR_HEIGHT = "NEEDS_FLOOR_HEIGHT"


class FloorPlacement(_Frozen):
    """Where an arrow end sits near the floor, and how that was determined."""

    position: Point3 | None
    """Floor point + vertical offset, or None when source is NEEDS_FLOOR_HEIGHT."""
    source: PlacementSource
    floor_id: str | None

    @model_validator(mode="after")
    def _position_matches_source(self) -> "FloorPlacement":
        if (self.position is None) != (self.source is PlacementSource.NEEDS_FLOOR_HEIGHT):
            raise ValueError("position must be None exactly when source is NEEDS_FLOOR_HEIGHT")
        return self


class ArrowStatus(str, Enum):
    STEP = "STEP"
    """Normal move to a connected sweep (same floor, or floor unknown: see floor_transition)."""
    FLOOR_TRANSITION = "FLOOR_TRANSITION"
    """Connected sweep on a different floor (stairs, elevator)."""
    ARRIVED = "ARRIVED"
    """Source and target are the same sweep. No direction."""


class ArrowInstruction(_Frozen):
    """Structured, validated instruction for one arrow. Rendering is someone else's job."""

    model_id: str = Field(min_length=1)
    coordinate_system: Literal["MATTERPORT_SDK_WORLD"] = COORDINATE_SYSTEM
    status: ArrowStatus
    source_sweep_id: str
    target_sweep_id: str

    anchor: FloorPlacement
    """Arrow base, at the source sweep's floor."""
    source_sweep_position: Point3
    """Source sweep's SDK (camera) position, for reference. Not a floor position."""
    target_position: Point3
    """Target sweep's SDK (camera) position."""
    target_floor: FloorPlacement
    """Target sweep's floor point, using the same placement rules as the anchor."""

    direction: Direction2D | None
    direction_status: Literal["OK", "ZERO_LENGTH", "NOT_APPLICABLE"]
    """NOT_APPLICABLE on ARRIVED. ZERO_LENGTH when the target is directly above/below."""
    horizontal_distance_m: float = Field(ge=0, allow_inf_nan=False)
    floor_transition: FloorTransition
    floor_sequence_delta: int | None
    """+1 = one floor up, -1 = one floor down, None when either floor is unknown."""
    vertical_offset_m: float = Field(allow_inf_nan=False)
    needs_floor_height: bool
    """True if the anchor or the target floor point couldn't be placed without a floor height."""

    @field_validator("floor_transition", mode="before")
    @classmethod
    def _coerce_transition(cls, v: object) -> object:
        return FloorTransition(v) if isinstance(v, str) else v

    @model_validator(mode="after")
    def _consistent(self) -> "ArrowInstruction":
        if (self.status is ArrowStatus.ARRIVED) != (self.source_sweep_id == self.target_sweep_id):
            raise ValueError("ARRIVED exactly when source and target are the same sweep")
        if self.status is ArrowStatus.ARRIVED and self.direction_status != "NOT_APPLICABLE":
            raise ValueError("ARRIVED has no direction")
        if (self.status is ArrowStatus.FLOOR_TRANSITION) != (self.floor_transition is FloorTransition.FLOOR_CHANGE):
            raise ValueError("FLOOR_TRANSITION exactly when the floor changes")
        if (self.direction is None) == (self.direction_status == "OK"):
            raise ValueError("direction is present exactly when direction_status is OK")
        expected = PlacementSource.NEEDS_FLOOR_HEIGHT in (self.anchor.source, self.target_floor.source)
        if self.needs_floor_height != expected:
            raise ValueError("needs_floor_height must match the placements")
        return self


class ArrowErrorStatus(str, Enum):
    UNKNOWN_SWEEP = "UNKNOWN_SWEEP"
    NOT_CONNECTED = "NOT_CONNECTED"


class ArrowError(_Frozen):
    model_id: str
    status: ArrowErrorStatus
    source_sweep_id: str
    target_sweep_id: str
    reason: str


# --- calculation ---------------------------------------------------------------------------


def _floor_placement(sweep: Sweep, config: ArrowConfig) -> FloorPlacement:
    floor_id = sweep.floor.id if sweep.floor else None
    offset = config.vertical_offset_m
    if sweep.puck_position is not None:
        p = sweep.puck_position
        return FloorPlacement(position=Point3(x=p.x, y=p.y + offset, z=p.z), source=PlacementSource.PUCK, floor_id=floor_id)
    if floor_id is not None and floor_id in config.floor_heights_m:
        y = config.floor_heights_m[floor_id] + offset
        return FloorPlacement(
            position=Point3(x=sweep.position.x, y=y, z=sweep.position.z),
            source=PlacementSource.SUPPLIED_FLOOR_HEIGHT,
            floor_id=floor_id,
        )
    return FloorPlacement(position=None, source=PlacementSource.NEEDS_FLOOR_HEIGHT, floor_id=floor_id)


def create_arrow_instructions(
    data: ModelNavigationData, from_sweep_id: str, to_sweep_id: str, config: ArrowConfig | None = None
) -> ArrowInstruction | ArrowError:
    """Validate one step and describe its arrow. Pure and deterministic."""
    config = config or ArrowConfig()

    for sweep_id in (from_sweep_id, to_sweep_id):
        if sweep_id not in data.sweeps:
            return ArrowError(
                model_id=data.model_id, status=ArrowErrorStatus.UNKNOWN_SWEEP,
                source_sweep_id=from_sweep_id, target_sweep_id=to_sweep_id,
                reason=f"Sweep {sweep_id!r} is not in model {data.model_id!r}.",
            )

    source, target = data.sweeps[from_sweep_id], data.sweeps[to_sweep_id]
    anchor = _floor_placement(source, config)
    target_floor = _floor_placement(target, config)
    common = dict(
        model_id=data.model_id,
        source_sweep_id=from_sweep_id,
        target_sweep_id=to_sweep_id,
        anchor=anchor,
        source_sweep_position=Point3.of(source.position),
        target_position=Point3.of(target.position),
        target_floor=target_floor,
        vertical_offset_m=config.vertical_offset_m,
        needs_floor_height=PlacementSource.NEEDS_FLOOR_HEIGHT in (anchor.source, target_floor.source),
    )

    if from_sweep_id == to_sweep_id:
        return ArrowInstruction(
            status=ArrowStatus.ARRIVED, direction=None, direction_status="NOT_APPLICABLE",
            horizontal_distance_m=0.0,
            floor_transition=FloorTransition.SAME_FLOOR if source.floor else FloorTransition.UNKNOWN,
            floor_sequence_delta=0 if source.floor else None,
            **common,
        )

    if to_sweep_id not in source.neighbor_ids:
        return ArrowError(
            model_id=data.model_id, status=ArrowErrorStatus.NOT_CONNECTED,
            source_sweep_id=from_sweep_id, target_sweep_id=to_sweep_id,
            reason=f"{from_sweep_id!r} does not list {to_sweep_id!r} as a neighbor (connections are one-way).",
        )

    dir_status, unit, horizontal = horizontal_direction(source.position, target.position)
    transition, delta = _floor_transition(source, target)
    return ArrowInstruction(
        status=ArrowStatus.FLOOR_TRANSITION if transition is FloorTransition.FLOOR_CHANGE else ArrowStatus.STEP,
        direction=Direction2D(x=unit.x, z=unit.z) if unit else None,
        direction_status="OK" if dir_status is DirectionStatus.OK else "ZERO_LENGTH",
        horizontal_distance_m=horizontal,
        floor_transition=transition,
        floor_sequence_delta=delta,
        **common,
    )