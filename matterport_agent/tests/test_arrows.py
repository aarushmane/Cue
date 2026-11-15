import math

import pytest
from pydantic import ValidationError

from matterport_agent.arrows import (
    ArrowConfig,
    ArrowError,
    ArrowErrorStatus,
    ArrowInstruction,
    ArrowStatus,
    Direction2D,
    PlacementSource,
    create_arrow_instructions,
)
from matterport_agent.models import FloorInfo, ModelNavigationData, Sweep, Vector3
from matterport_agent.routing import FloorTransition
from matterport_agent.sample_data import SAMPLE_MODEL_ID, build_sample_model

S = "SAMPLE-sweep-"


@pytest.fixture(scope="module")
def sample():
    return build_sample_model()


def arrow(data, a, b, **cfg) -> ArrowInstruction:
    result = create_arrow_instructions(data, S + a, S + b, ArrowConfig(**cfg))
    assert isinstance(result, ArrowInstruction), result
    return result


def test_normal_step_uses_puck_for_anchor(sample):
    r = arrow(sample, "entrance", "help-desk", vertical_offset_m=0.1)
    assert r.status is ArrowStatus.STEP
    assert r.model_id == SAMPLE_MODEL_ID and r.coordinate_system == "MATTERPORT_SDK_WORLD"
    assert r.anchor.source is PlacementSource.PUCK
    assert (r.anchor.position.x, r.anchor.position.y, r.anchor.position.z) == pytest.approx((0, 0.1, 0))
    assert (r.target_position.x, r.target_position.y, r.target_position.z) == (3, 1.5, 0)
    assert (r.direction.x, r.direction.z) == pytest.approx((1.0, 0.0))
    assert r.horizontal_distance_m == pytest.approx(3.0)
    assert not r.needs_floor_height


def test_direction_is_normalized_diagonal():
    m = "TEST-model"
    data = ModelNavigationData.build(m, [
        Sweep(m, "a", Vector3(0, 1.5, 0), ("b",)),
        Sweep(m, "b", Vector3(3, 9.0, -4), ()),  # height difference is ignored
    ], [])
    r = create_arrow_instructions(data, "a", "b")
    assert (r.direction.x, r.direction.z) == pytest.approx((0.6, -0.8))
    assert math.hypot(r.direction.x, r.direction.z) == pytest.approx(1.0)
    assert r.horizontal_distance_m == pytest.approx(5.0)


def test_floor_transition_with_zero_length_direction(sample):
    r = arrow(sample, "stairs-bottom", "stairs-top")
    assert r.status is ArrowStatus.FLOOR_TRANSITION
    assert r.floor_transition is FloorTransition.FLOOR_CHANGE and r.floor_sequence_delta == 1
    assert r.direction is None and r.direction_status == "ZERO_LENGTH"
    assert r.anchor.position.y == pytest.approx(0.05)       # ground floor puck + default offset
    assert r.target_floor.position.y == pytest.approx(3.05)  # upper floor puck + default offset


def test_arrival(sample):
    r = arrow(sample, "mezzanine", "mezzanine")
    assert r.status is ArrowStatus.ARRIVED
    assert r.direction is None and r.direction_status == "NOT_APPLICABLE"


def test_missing_puck_needs_floor_height_and_never_uses_camera_height(sample):
    r = arrow(sample, "aisle-1-back", "aisle-1-front")
    assert r.anchor.source is PlacementSource.NEEDS_FLOOR_HEIGHT
    assert r.anchor.position is None
    assert r.needs_floor_height
    assert r.source_sweep_position.y == 1.5  # camera height is reported separately, not used


def test_supplied_floor_height_is_used_when_no_puck(sample):
    r = arrow(sample, "aisle-1-back", "aisle-1-front", vertical_offset_m=0.2, floor_heights_m={"SAMPLE-floor-0": -0.01})
    assert r.anchor.source is PlacementSource.SUPPLIED_FLOOR_HEIGHT
    assert (r.anchor.position.x, r.anchor.position.y, r.anchor.position.z) == pytest.approx((0, 0.19, -10))
    assert not r.needs_floor_height


def test_unknown_floor_reports_unknown_transition():
    m = "TEST-model"
    data = ModelNavigationData.build(m, [
        Sweep(m, "a", Vector3(0, 1.5, 0), ("b",), floor=FloorInfo("f0", 0)),
        Sweep(m, "b", Vector3(1, 1.5, 0), ()),
    ], [])
    r = create_arrow_instructions(data, "a", "b")
    assert r.status is ArrowStatus.STEP
    assert r.floor_transition is FloorTransition.UNKNOWN and r.floor_sequence_delta is None
    assert r.target_floor.source is PlacementSource.NEEDS_FLOOR_HEIGHT


def test_undeclared_and_reverse_one_way_connections_are_rejected(sample):
    not_neighbors = create_arrow_instructions(sample, S + "entrance", S + "mezzanine")
    assert isinstance(not_neighbors, ArrowError) and not_neighbors.status is ArrowErrorStatus.NOT_CONNECTED
    reverse = create_arrow_instructions(sample, S + "help-desk", S + "checkout")  # only checkout -> help-desk exists
    assert isinstance(reverse, ArrowError) and reverse.status is ArrowErrorStatus.NOT_CONNECTED


def test_unknown_sweep_is_rejected(sample):
    r = create_arrow_instructions(sample, S + "entrance", "made-up")
    assert isinstance(r, ArrowError) and r.status is ArrowErrorStatus.UNKNOWN_SWEEP


def test_schema_rejects_non_unit_direction_and_bad_config():
    with pytest.raises(ValidationError):
        Direction2D(x=1.0, z=1.0)
    with pytest.raises(ValueError):
        ArrowConfig(vertical_offset_m=float("nan"))


def test_results_are_immutable(sample):
    r = arrow(sample, "entrance", "help-desk")
    with pytest.raises(ValidationError):
        r.status = ArrowStatus.ARRIVED
