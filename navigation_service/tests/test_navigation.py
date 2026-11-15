import math

import pytest

from app.navigation.models import (
    Destination,
    FloorInfo,
    ModelNavigationData,
    NavigationDataError,
    Sweep,
    Vector3,
)
from app.navigation.sample_data import SAMPLE_MODEL_ID, build_sample_model
from app.navigation.service import (
    DirectionStatus,
    FloorTransition,
    PlanStatus,
    horizontal_direction,
    plan_navigation,
    resolve_destination,
)

S = "SAMPLE-sweep-"


@pytest.fixture(scope="module")
def sample() -> ModelNavigationData:
    return build_sample_model()


def tiny(model_id: str, sweeps: list[tuple[str, tuple[float, float, float], list[str]]]) -> ModelNavigationData:
    return ModelNavigationData.build(
        model_id,
        [Sweep(model_id, sid, Vector3(*xyz), tuple(n)) for sid, xyz, n in sweeps],
        [],
    )


# --- routing -----------------------------------------------------------------


def test_shortest_route_follows_declared_neighbors(sample):
    plan = plan_navigation(sample, S + "entrance", S + "aisle-1-back")
    assert plan.status is PlanStatus.ROUTE
    assert plan.sweep_ids == (S + "entrance", S + "aisle-1-front", S + "aisle-1-back")
    assert plan.total_distance_m == pytest.approx(10.0)
    assert [s.index for s in plan.steps] == [0, 1]


def test_dijkstra_picks_shorter_distance_not_fewer_hops():
    # 2 hops via far-away x (~20 m) vs 3 hops along a straight line (1 m).
    data = tiny("TEST-model", [
        ("a", (0, 0, 0), ["x", "b1"]),
        ("x", (0, 0, 10), ["c"]),
        ("b1", (0.3, 0, 0), ["b2"]),
        ("b2", (0.6, 0, 0), ["c"]),
        ("c", (1, 0, 0), []),
    ])
    plan = plan_navigation(data, "a", "c")
    assert plan.sweep_ids == ("a", "b1", "b2", "c")
    assert plan.total_distance_m == pytest.approx(1.0)


def test_directed_connections_are_respected(sample):
    # checkout -> help-desk exists, but help-desk -> checkout does not.
    forward = plan_navigation(sample, S + "checkout", S + "help-desk")
    assert forward.sweep_ids == (S + "checkout", S + "help-desk")

    # So the reverse trip must go the long way round via aisle 1.
    back = plan_navigation(sample, S + "help-desk", S + "checkout")
    assert back.status is PlanStatus.ROUTE
    assert back.sweep_ids == (S + "help-desk", S + "aisle-1-front", S + "aisle-1-back", S + "checkout")


def test_one_way_only_graph_is_unreachable_in_reverse():
    data = tiny("TEST-model", [("a", (0, 0, 0), ["b"]), ("b", (1, 0, 0), [])])
    assert plan_navigation(data, "a", "b").status is PlanStatus.ROUTE
    assert plan_navigation(data, "b", "a").status is PlanStatus.UNREACHABLE


def test_unreachable_destination(sample):
    plan = plan_navigation(sample, S + "entrance", S + "storage-room")
    assert plan.status is PlanStatus.UNREACHABLE
    assert plan.sweep_ids == () and plan.steps == () and plan.total_distance_m is None


def test_arrived(sample):
    plan = plan_navigation(sample, S + "mezzanine", S + "mezzanine")
    assert plan.status is PlanStatus.ARRIVED
    assert plan.steps == ()


def test_unknown_sweep_ids_are_rejected(sample):
    assert plan_navigation(sample, "not-a-sweep", S + "entrance").status is PlanStatus.UNKNOWN_START
    assert plan_navigation(sample, S + "entrance", "not-a-sweep").status is PlanStatus.UNKNOWN_DESTINATION


def test_routing_is_deterministic(sample):
    runs = {plan_navigation(sample, S + "checkout", S + "mezzanine").sweep_ids for _ in range(20)}
    assert len(runs) == 1


# --- destinations and model scoping -------------------------------------------


def test_resolve_destination_by_name_and_alias(sample):
    assert resolve_destination(sample, "  help DESK ")["sweep_id"] == S + "help-desk"
    assert resolve_destination(sample, "upstairs")["sweep_id"] == S + "mezzanine"
    missing = resolve_destination(sample, "bakery")
    assert missing["status"] == "UNKNOWN_DESTINATION"
    assert "Help desk" in missing["available_destinations"]


def test_sample_data_is_labeled(sample):
    assert sample.is_sample
    assert sample.model_id == SAMPLE_MODEL_ID and SAMPLE_MODEL_ID.startswith("SAMPLE")
    assert all(sid.startswith("SAMPLE") for sid in sample.sweeps)


def test_sweeps_from_another_model_are_rejected():
    with pytest.raises(NavigationDataError, match="belongs to model"):
        ModelNavigationData.build("model-A", [Sweep("model-B", "a", Vector3(0, 0, 0), ())], [])


def test_undeclared_neighbors_and_destinations_are_rejected():
    with pytest.raises(NavigationDataError, match="unknown neighbor"):
        tiny("TEST-model", [("a", (0, 0, 0), ["ghost"])])
    with pytest.raises(NavigationDataError, match="unknown sweep"):
        ModelNavigationData.build(
            "TEST-model", [Sweep("TEST-model", "a", Vector3(0, 0, 0), ())], [Destination("Ghost", "ghost")]
        )


def test_non_finite_coordinates_are_rejected():
    with pytest.raises(NavigationDataError):
        Vector3(float("nan"), 0, 0)


# --- arrow directions ---------------------------------------------------------


@pytest.mark.parametrize(
    ("target", "expected"),
    [
        ((5, 0, 0), (1.0, 0.0)),
        ((0, 0, -2), (0.0, -1.0)),
        ((3, 99, 4), (0.6, 0.8)),  # Y (height) is ignored
    ],
)
def test_horizontal_direction_is_normalized_on_xz(target, expected):
    status, direction, length = horizontal_direction(Vector3(0, 0, 0), Vector3(*target))
    assert status is DirectionStatus.OK
    assert (direction.x, direction.z) == pytest.approx(expected)
    assert math.hypot(direction.x, direction.z) == pytest.approx(1.0)
    assert length == pytest.approx(math.hypot(target[0], target[2]))


def test_zero_length_direction_has_no_arrow():
    status, direction, length = horizontal_direction(Vector3(1, 0, 1), Vector3(1, 3, 1))
    assert status is DirectionStatus.ZERO_LENGTH
    assert direction is None and length == 0.0


def test_floor_transition_step_is_explicit(sample):
    plan = plan_navigation(sample, S + "aisle-1-front", S + "mezzanine")
    assert plan.sweep_ids == (S + "aisle-1-front", S + "stairs-bottom", S + "stairs-top", S + "mezzanine")
    walk, stairs, upstairs = plan.steps

    assert walk.floor_transition is FloorTransition.SAME_FLOOR
    assert (walk.direction.x, walk.direction.z) == pytest.approx((-1.0, 0.0))

    assert stairs.floor_transition is FloorTransition.FLOOR_CHANGE
    assert stairs.floor_sequence_delta == 1
    assert stairs.direction_status is DirectionStatus.ZERO_LENGTH and stairs.direction is None
    assert stairs.distance_m == pytest.approx(3.0)

    assert upstairs.floor_transition is FloorTransition.SAME_FLOOR
    assert (upstairs.direction.x, upstairs.direction.z) == pytest.approx((0.0, -1.0))


def test_unknown_floor_is_reported_as_unknown():
    model = "TEST-model"
    data = ModelNavigationData.build(model, [
        Sweep(model, "a", Vector3(0, 0, 0), ("b",), floor=FloorInfo("f0", 0)),
        Sweep(model, "b", Vector3(1, 0, 0), ()),
    ], [])
    step = plan_navigation(data, "a", "b").steps[0]
    assert step.floor_transition is FloorTransition.UNKNOWN
    assert step.floor_sequence_delta is None
