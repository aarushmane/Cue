"""SAMPLE DATA FOR LOCAL TESTING ONLY.

None of these IDs are real Matterport IDs. Real model IDs are 11-character strings and
real sweep IDs come from the SDK (sweep.data); these are made up and prefixed "SAMPLE"
so they can never be confused with production data. Coordinates are invented for tests.

Connections (<-> two-way, -> one-way):

    entrance <-> help-desk, entrance <-> aisle-1-front, help-desk <-> aisle-1-front
    aisle-1-front <-> aisle-1-back <-> ... aisle-1-back -> checkout -> help-desk
    aisle-1-front <-> stairs-bottom <-> stairs-top (floor 1, directly above) <-> mezzanine
    storage-room: no connections at all (tests UNREACHABLE)
"""

from __future__ import annotations

from .models import Destination, FloorInfo, ModelNavigationData, Sweep, Vector3

SAMPLE_MODEL_ID = "SAMPLE-MODEL-local-test"

_GROUND = FloorInfo(id="SAMPLE-floor-0", sequence=0)
_UPPER = FloorInfo(id="SAMPLE-floor-1", sequence=1)


def _sweep(sweep_id: str, xyz: tuple[float, float, float], neighbors: list[str], floor: FloorInfo | None,
           puck: tuple[float, float, float] | None = None) -> Sweep:
    return Sweep(
        model_id=SAMPLE_MODEL_ID,
        sweep_id=sweep_id,
        position=Vector3(*xyz),
        neighbor_ids=tuple(neighbors),
        puck_position=Vector3(*puck) if puck else None,
        floor=floor,
    )


def build_sample_model() -> ModelNavigationData:
    sweeps = [
        _sweep("SAMPLE-sweep-entrance", (0, 1.5, 0), ["SAMPLE-sweep-help-desk", "SAMPLE-sweep-aisle-1-front"], _GROUND, (0, 0, 0)),
        _sweep("SAMPLE-sweep-help-desk", (3, 1.5, 0), ["SAMPLE-sweep-entrance", "SAMPLE-sweep-aisle-1-front"], _GROUND, (3, 0, 0)),
        _sweep("SAMPLE-sweep-aisle-1-front", (0, 1.5, -5),
               ["SAMPLE-sweep-entrance", "SAMPLE-sweep-help-desk", "SAMPLE-sweep-aisle-1-back", "SAMPLE-sweep-stairs-bottom"], _GROUND),
        _sweep("SAMPLE-sweep-aisle-1-back", (0, 1.5, -10), ["SAMPLE-sweep-aisle-1-front", "SAMPLE-sweep-checkout"], _GROUND),
        # One-way: checkout leads to the help desk, but nothing leads back into checkout except aisle 1 back.
        _sweep("SAMPLE-sweep-checkout", (4, 1.5, -10), ["SAMPLE-sweep-help-desk"], _GROUND),
        _sweep("SAMPLE-sweep-stairs-bottom", (-3, 1.5, -5), ["SAMPLE-sweep-aisle-1-front", "SAMPLE-sweep-stairs-top"], _GROUND),
        # Directly above stairs-bottom: zero horizontal length and a floor change.
        _sweep("SAMPLE-sweep-stairs-top", (-3, 4.5, -5), ["SAMPLE-sweep-stairs-bottom", "SAMPLE-sweep-mezzanine"], _UPPER),
        _sweep("SAMPLE-sweep-mezzanine", (-3, 4.5, -9), ["SAMPLE-sweep-stairs-top"], _UPPER, (-3, 3, -9)),
        # Disconnected on purpose: no sweep lists it as a neighbor. Floor unknown.
        _sweep("SAMPLE-sweep-storage-room", (10, 1.5, 10), [], None),
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
