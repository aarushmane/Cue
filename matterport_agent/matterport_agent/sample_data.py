"""SAMPLE DATA FOR LOCAL TESTING ONLY. NOT REAL MATTERPORT DATA.

Every ID here is made up and starts with "SAMPLE" so it can't be mistaken for a real
Matterport model ID (11 characters) or a real sweep ID (from the SDK's sweep.data).

Coordinates are Matterport SDK world coordinates in meters, Y up. They are consistent:
each sweep's camera sits 1.5 m above its floor, and where a puck position is given it
shares the sweep's X/Z and sits on the floor (ground floor Y = 0.0, upper floor Y = 3.0).

Connections (<-> two-way, -> one-way):
    entrance <-> help-desk, entrance <-> aisle-1-front, help-desk <-> aisle-1-front
    aisle-1-front <-> aisle-1-back, aisle-1-back -> checkout -> help-desk
    aisle-1-front <-> stairs-bottom <-> stairs-top (upper floor, directly above) <-> mezzanine
    storage-room: no connections (exercises UNREACHABLE)

Deliberate gaps, to exercise edge cases:
    aisle-1-back and storage-room have no puck position.
    storage-room has no floor info.
"""

from __future__ import annotations

from .models import Destination, FloorInfo, ModelNavigationData, Sweep, Vector3

SAMPLE_MODEL_ID = "SAMPLE-MODEL-local-test"

GROUND_FLOOR = FloorInfo(id="SAMPLE-floor-0", sequence=0)
UPPER_FLOOR = FloorInfo(id="SAMPLE-floor-1", sequence=1)
CAMERA_HEIGHT_M = 1.5
_FLOOR_Y = {GROUND_FLOOR.id: 0.0, UPPER_FLOOR.id: 3.0}


def _sweep(name: str, x: float, z: float, neighbors: list[str], floor: FloorInfo | None, *, puck: bool = True) -> Sweep:
    floor_y = _FLOOR_Y[floor.id] if floor else 0.0
    return Sweep(
        model_id=SAMPLE_MODEL_ID,
        sweep_id=f"SAMPLE-sweep-{name}",
        position=Vector3(x, floor_y + CAMERA_HEIGHT_M, z),
        neighbor_ids=tuple(f"SAMPLE-sweep-{n}" for n in neighbors),
        puck_position=Vector3(x, floor_y, z) if puck and floor else None,
        floor=floor,
    )


def build_sample_model() -> ModelNavigationData:
    sweeps = [
        _sweep("entrance", 0, 0, ["help-desk", "aisle-1-front"], GROUND_FLOOR),
        _sweep("help-desk", 3, 0, ["entrance", "aisle-1-front"], GROUND_FLOOR),
        _sweep("aisle-1-front", 0, -5, ["entrance", "help-desk", "aisle-1-back", "stairs-bottom"], GROUND_FLOOR),
        _sweep("aisle-1-back", 0, -10, ["aisle-1-front", "checkout"], GROUND_FLOOR, puck=False),
        _sweep("checkout", 4, -10, ["help-desk"], GROUND_FLOOR),
        _sweep("stairs-bottom", -3, -5, ["aisle-1-front", "stairs-top"], GROUND_FLOOR),
        _sweep("stairs-top", -3, -5, ["stairs-bottom", "mezzanine"], UPPER_FLOOR),
        _sweep("mezzanine", -3, -9, ["stairs-top"], UPPER_FLOOR),
        _sweep("storage-room", 10, 10, [], None, puck=False),
    ]
    destinations = [
        Destination("Entrance", "SAMPLE-sweep-entrance", ("front door",)),
        Destination("Help desk", "SAMPLE-sweep-help-desk", ("customer service",)),
        Destination("Aisle 1", "SAMPLE-sweep-aisle-1-front"),
        Destination("Checkout", "SAMPLE-sweep-checkout", ("registers",)),
        Destination("Mezzanine", "SAMPLE-sweep-mezzanine", ("upstairs",)),
        Destination("Storage room (sample, unreachable)", "SAMPLE-sweep-storage-room", ("storage room",)),
    ]
    return ModelNavigationData.build(SAMPLE_MODEL_ID, sweeps, destinations, is_sample=True)
