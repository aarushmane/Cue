import pytest

from matterport_agent.models import Destination, ModelNavigationData, NavigationDataError, Sweep, Vector3
from matterport_agent.routing import PlanStatus, plan_navigation, resolve_destination
from matterport_agent.sample_data import SAMPLE_MODEL_ID, build_sample_model

S = "SAMPLE-sweep-"


@pytest.fixture(scope="module")
def sample():
    return build_sample_model()


def tiny(sweeps):
    m = "TEST-model"
    return ModelNavigationData.build(m, [Sweep(m, sid, Vector3(*xyz), tuple(n)) for sid, xyz, n in sweeps], [])


def test_shortest_distance_wins_over_fewest_hops():
    data = tiny([
        ("a", (0, 0, 0), ["far", "b1"]),
        ("far", (0, 0, 10), ["c"]),
        ("b1", (0.3, 0, 0), ["b2"]),
        ("b2", (0.6, 0, 0), ["c"]),
        ("c", (1, 0, 0), []),
    ])
    plan = plan_navigation(data, "a", "c")
    assert plan.sweep_ids == ("a", "b1", "b2", "c")
    assert plan.total_distance_m == pytest.approx(1.0)


def test_one_way_connections_are_respected(sample):
    assert plan_navigation(sample, S + "checkout", S + "help-desk").sweep_ids == (S + "checkout", S + "help-desk")
    back = plan_navigation(sample, S + "help-desk", S + "checkout")
    assert back.sweep_ids == (S + "help-desk", S + "aisle-1-front", S + "aisle-1-back", S + "checkout")


def test_reverse_of_one_way_only_link_is_unreachable():
    data = tiny([("a", (0, 0, 0), ["b"]), ("b", (1, 0, 0), [])])
    assert plan_navigation(data, "b", "a").status is PlanStatus.UNREACHABLE


def test_disconnected_destination_is_unreachable(sample):
    plan = plan_navigation(sample, S + "entrance", S + "storage-room")
    assert plan.status is PlanStatus.UNREACHABLE
    assert plan.sweep_ids == () and plan.total_distance_m is None


def test_arrived(sample):
    assert plan_navigation(sample, S + "entrance", S + "entrance").status is PlanStatus.ARRIVED


def test_unknown_ids(sample):
    assert plan_navigation(sample, "nope", S + "entrance").status is PlanStatus.UNKNOWN_START
    assert plan_navigation(sample, S + "entrance", "nope").status is PlanStatus.UNKNOWN_DESTINATION


def test_resolve_destination(sample):
    assert resolve_destination(sample, "  CUSTOMER service")["sweep_id"] == S + "help-desk"
    miss = resolve_destination(sample, "bakery")
    assert miss["status"] == "UNKNOWN_DESTINATION" and "Checkout" in miss["available_destinations"]


def test_sample_data_is_labeled_and_consistent(sample):
    assert sample.is_sample and SAMPLE_MODEL_ID.startswith("SAMPLE")
    for sweep in sample.sweeps.values():
        assert sweep.sweep_id.startswith("SAMPLE-") and sweep.model_id == SAMPLE_MODEL_ID
        if sweep.puck_position:  # puck sits on the floor directly under the camera
            assert (sweep.puck_position.x, sweep.puck_position.z) == (sweep.position.x, sweep.position.z)
            assert sweep.position.y - sweep.puck_position.y == pytest.approx(1.5)


def test_bad_data_is_rejected_not_repaired():
    with pytest.raises(NavigationDataError, match="unknown neighbor"):
        tiny([("a", (0, 0, 0), ["ghost"])])
    with pytest.raises(NavigationDataError, match="belongs to model"):
        ModelNavigationData.build("A", [Sweep("B", "a", Vector3(0, 0, 0), ())], [])
    with pytest.raises(NavigationDataError, match="unknown sweep"):
        ModelNavigationData.build("A", [Sweep("A", "a", Vector3(0, 0, 0), ())], [Destination("X", "ghost")])
