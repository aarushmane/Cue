"""Tool wiring and agent wiring, with no paid model calls."""

import json
from types import SimpleNamespace

from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, ToolMessage

from matterport_agent.agent import DEFAULT_MODEL, MODEL_ENV_VAR, build_navigation_agent, resolve_model
from matterport_agent.arrows import ArrowConfig
from matterport_agent.context import NavigationSession
from matterport_agent.models import ModelNavigationData, Sweep, Vector3
from matterport_agent.sample_data import build_sample_model
from matterport_agent.tools import NAVIGATION_TOOLS, create_arrow_instructions, plan_navigation, resolve_destination

S = "SAMPLE-sweep-"


def runtime(session):
    return SimpleNamespace(context=session)


def test_tool_names_and_model_visible_args():
    schemas = {t.name: set(t.tool_call_schema.model_json_schema()["properties"]) for t in NAVIGATION_TOOLS}
    assert schemas == {
        "resolve_destination": {"name"},
        "plan_navigation": {"start_id", "destination_id"},
        "create_arrow_instructions": {"from_sweep_id", "to_sweep_id"},
    }  # `runtime` is hidden from the model


def test_tools_use_session_data_only():
    sample = NavigationSession(build_sample_model())
    other = NavigationSession(ModelNavigationData.build("TEST-other", [Sweep("TEST-other", "x", Vector3(0, 0, 0), ())], []))

    assert resolve_destination.func(name="Checkout", runtime=runtime(sample))["sweep_id"] == S + "checkout"
    assert plan_navigation.func(start_id=S + "entrance", destination_id=S + "checkout", runtime=runtime(sample))["status"] == "ROUTE"
    # Same tool, different session: the sample sweeps don't exist there.
    assert plan_navigation.func(start_id=S + "entrance", destination_id=S + "checkout", runtime=runtime(other))["status"] == "UNKNOWN_START"


def test_arrow_tool_uses_session_offset():
    session = NavigationSession(build_sample_model(), ArrowConfig(vertical_offset_m=0.25))
    out = create_arrow_instructions.func(from_sweep_id=S + "entrance", to_sweep_id=S + "help-desk", runtime=runtime(session))
    assert out["status"] == "STEP" and out["anchor"]["position"]["y"] == 0.25
    json.dumps(out)  # plain JSON, safe to hand to a model or a viewer later


def test_model_comes_from_env(monkeypatch):
    monkeypatch.delenv(MODEL_ENV_VAR, raising=False)
    assert resolve_model() == DEFAULT_MODEL
    monkeypatch.setenv(MODEL_ENV_VAR, "anthropic:claude-sonnet-5-5")
    assert resolve_model() == "anthropic:claude-sonnet-5-5"


class ScriptedModel(GenericFakeChatModel):
    """Fake chat model that replays fixed messages; enough to drive the agent loop for free."""

    def bind_tools(self, tools, **kwargs):
        return self


def test_deep_agent_calls_arrow_tool_with_session_context():
    script = iter([
        AIMessage(content="", tool_calls=[{
            "id": "call-1", "name": "create_arrow_instructions",
            "args": {"from_sweep_id": S + "stairs-bottom", "to_sweep_id": S + "stairs-top"},
        }]),
        AIMessage(content="Take the stairs up one floor."),
    ])
    agent = build_navigation_agent(model=ScriptedModel(messages=script))
    result = agent.invoke(
        {"messages": [{"role": "user", "content": f"I am at sweep {S}stairs-bottom. Go up."}]},
        context=NavigationSession(build_sample_model()),
    )
    tool_messages = [m for m in result["messages"] if isinstance(m, ToolMessage)]
    assert len(tool_messages) == 1
    payload = json.loads(tool_messages[0].content)
    assert payload["status"] == "FLOOR_TRANSITION" and payload["direction"] is None
    assert result["messages"][-1].content == "Take the stairs up one floor."
