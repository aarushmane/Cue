"""Session data must serialize cleanly, because LangChain dumps tool inputs (including the hidden
runtime context) with pydantic on every tool call. It must also stay read-only and per-session."""

import json
import warnings
from types import MappingProxyType

import pytest
from pydantic import TypeAdapter

from matterport_agent.arrows import ArrowConfig
from matterport_agent.context import NavigationSession
from matterport_agent.sample_data import SAMPLE_MODEL_ID, build_sample_model

S = "SAMPLE-sweep-"
ADAPTER = TypeAdapter(NavigationSession)


@pytest.fixture
def session():
    return NavigationSession(build_sample_model(), ArrowConfig(vertical_offset_m=0.1, floor_heights_m={"SAMPLE-floor-0": 0.0}))


def dump(session, **kwargs):
    with warnings.catch_warnings():
        warnings.simplefilter("error")  # any serializer warning fails the test
        return ADAPTER.dump_python(session, **kwargs)


def test_session_serializes_to_plain_data_without_warnings(session):
    data = dump(session)
    model = data["model_data"]
    assert model["model_id"] == SAMPLE_MODEL_ID and model["is_sample"] is True
    assert type(model["sweeps"]) is dict and set(model["sweeps"]) == set(session.model_data.sweeps)
    assert model["sweeps"][S + "stairs-top"] == {
        "model_id": SAMPLE_MODEL_ID,
        "sweep_id": S + "stairs-top",
        "position": {"x": -3, "y": 4.5, "z": -5},
        "neighbor_ids": (S + "stairs-bottom", S + "mezzanine"),
        "puck_position": {"x": -3, "y": 3.0, "z": -5},
        "floor": {"id": "SAMPLE-floor-1", "sequence": 1},
    }
    assert type(data["arrow_config"]["floor_heights_m"]) is dict
    assert data["arrow_config"] == {"vertical_offset_m": 0.1, "floor_heights_m": {"SAMPLE-floor-0": 0.0}}


def test_session_serializes_to_json(session):
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        parsed = json.loads(ADAPTER.dump_json(session))
    assert parsed["model_data"]["sweeps"][S + "entrance"]["neighbor_ids"] == [S + "help-desk", S + "aisle-1-front"]


def test_serialized_copy_cannot_mutate_the_session(session):
    data = dump(session)
    data["model_data"]["sweeps"].clear()
    data["arrow_config"]["floor_heights_m"]["SAMPLE-floor-0"] = 99.0
    assert len(session.model_data.sweeps) == 9
    assert session.arrow_config.floor_heights_m["SAMPLE-floor-0"] == 0.0


def test_session_stays_read_only_and_is_not_copied_on_validation(session):
    assert isinstance(session.model_data.sweeps, MappingProxyType)
    assert isinstance(session.arrow_config.floor_heights_m, MappingProxyType)
    with pytest.raises(TypeError):
        session.model_data.sweeps["new"] = None
    with pytest.raises(TypeError):
        session.arrow_config.floor_heights_m["new"] = 1.0
    assert ADAPTER.validate_python(session) is session  # same object: no hidden per-call copies


def test_two_sessions_stay_independent():
    a = NavigationSession(build_sample_model(), ArrowConfig(floor_heights_m={"SAMPLE-floor-0": 0.0}))
    b = NavigationSession(build_sample_model(), ArrowConfig(floor_heights_m={"SAMPLE-floor-0": 2.0}))
    assert dump(a)["arrow_config"]["floor_heights_m"] != dump(b)["arrow_config"]["floor_heights_m"]
    assert a.model_data.sweeps is not b.model_data.sweeps


def test_caller_dict_is_copied_into_config():
    heights = {"SAMPLE-floor-0": 0.0}
    config = ArrowConfig(floor_heights_m=heights)
    heights["SAMPLE-floor-0"] = 5.0  # changing the caller's dict later doesn't leak in
    assert config.floor_heights_m["SAMPLE-floor-0"] == 0.0
