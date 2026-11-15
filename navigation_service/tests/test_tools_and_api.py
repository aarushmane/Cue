from fastapi.testclient import TestClient

from app.agent.tools import build_navigation_tools
from app.main import create_app
from app.navigation.repository import NavigationRepository
from app.navigation.models import ModelNavigationData, Sweep, Vector3
from app.navigation.sample_data import SAMPLE_MODEL_ID, build_sample_model

S = "SAMPLE-sweep-"


def tools_by_name(data):
    return {t.name: t for t in build_navigation_tools(data)}


def test_tools_have_expected_names_and_args():
    tools = tools_by_name(build_sample_model())
    assert set(tools) == {"resolve_destination", "plan_navigation"}
    assert set(tools["resolve_destination"].args) == {"name"}
    assert set(tools["plan_navigation"].args) == {"start_id", "destination_id"}


def test_tools_resolve_then_plan():
    tools = tools_by_name(build_sample_model())
    dest = tools["resolve_destination"].invoke({"name": "Checkout"})
    assert dest["status"] == "MATCH"
    plan = tools["plan_navigation"].invoke({"start_id": S + "entrance", "destination_id": dest["sweep_id"]})
    assert plan["status"] == "ROUTE"
    assert plan["sweep_ids"][-1] == S + "checkout"
    assert plan["steps"][0]["direction_status"] == "OK"


def test_tools_are_scoped_to_one_model():
    other = ModelNavigationData.build("TEST-other", [Sweep("TEST-other", "only", Vector3(0, 0, 0), ())], [])
    tools = tools_by_name(other)
    result = tools["plan_navigation"].invoke({"start_id": S + "entrance", "destination_id": S + "checkout"})
    assert result["status"] == "UNKNOWN_START"
    assert result["model_id"] == "TEST-other"


def test_api_plan_and_unknown_model():
    client = TestClient(create_app(NavigationRepository([build_sample_model()])))
    ok = client.post(
        f"/models/{SAMPLE_MODEL_ID}/navigation/plan",
        json={"start_sweep_id": S + "entrance", "destination_sweep_id": S + "storage-room"},
    )
    assert ok.status_code == 200 and ok.json()["status"] == "UNREACHABLE"

    missing = client.post("/models/nope/navigation/resolve", json={"name": "Help desk"})
    assert missing.status_code == 404
