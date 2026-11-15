import json

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from matterport_agent import report
from matterport_agent.context import NavigationSession
from matterport_agent.sample_data import build_sample_model

S = "SAMPLE-sweep-"


def session():
    return NavigationSession(build_sample_model())


def test_events_pair_calls_with_results():
    messages = [
        HumanMessage("go"),
        AIMessage(content="", tool_calls=[{"id": "t1", "name": "resolve_destination", "args": {"name": "Checkout"}}]),
        ToolMessage(content=json.dumps({"status": "MATCH", "sweep_id": S + "checkout"}), tool_call_id="t1"),
        AIMessage(content="", tool_calls=[{"id": "t2", "name": "write_todos", "args": {"todos": []}}]),
        ToolMessage(content="Updated todo list", tool_call_id="t2"),
    ]
    events = report.events_from_messages(messages)
    assert [(e.name, e.args) for e in events] == [("resolve_destination", {"name": "Checkout"}), ("write_todos", {"todos": []})]
    assert events[0].result["sweep_id"] == S + "checkout"
    assert events[1].result == "Updated todo list"  # built-in tools return plain text


def test_final_answer_never_includes_reasoning():
    message = AIMessage(content=[
        {"type": "thinking", "thinking": "PRIVATE REASONING", "signature": "sig"},
        {"type": "redacted_thinking", "data": "xyz"},
        {"type": "text", "text": "Walk forward to checkout."},
    ])
    text = report.final_answer_text(message)
    assert text == "Walk forward to checkout."
    assert "PRIVATE" not in text


def test_missing_arrow_call_is_flagged_and_computed_separately():
    s = session()
    events = report.run_tools_offline(s, "Checkout", S + "aisle-1-back")
    without_arrows = [e for e in events if e.name != "create_arrow_instructions"]
    plan = report.last_plan(without_arrows)
    arrow, source = report.next_arrow(without_arrows, plan)
    lines = "\n".join(report.format_arrow(arrow, source, s, plan))
    assert "did not call create_arrow_instructions" in lines
    assert "Computed directly by the demo" in lines


def test_consistency_check_detects_a_wrong_start():
    s = session()
    events = report.run_tools_offline(s, "Checkout", S + "aisle-1-back")
    assert "matches" in report.format_consistency(events, s, S + "aisle-1-back")[0]
    assert "differs" in report.format_consistency(events, s, S + "entrance")[0]


def test_floor_change_and_missing_floor_height_are_called_out():
    s = session()
    events = report.run_tools_offline(s, "Mezzanine", S + "stairs-bottom")
    plan = report.last_plan(events)
    assert any("floor change" in line for line in report.format_route(plan))
    arrow, source = report.next_arrow(events, plan)
    lines = "\n".join(report.format_arrow(arrow, source, s, plan))
    assert "[FLOOR_TRANSITION]" in lines and "none (ZERO_LENGTH)" in lines

    events = report.run_tools_offline(s, "Checkout", S + "aisle-1-back")  # aisle-1-back has no puck
    lines = "\n".join(report.format_arrow(*report.next_arrow(events, report.last_plan(events)), s, report.last_plan(events)))
    assert "needs a floor height" in lines


def test_agent_mode_report_end_to_end(monkeypatch, capsys):
    """demo.main in agent mode with a scripted fake model: no network, no cost."""
    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel

    from matterport_agent import agent as agent_module
    from matterport_agent import demo

    class Scripted(GenericFakeChatModel):
        def bind_tools(self, tools, **kwargs):
            return self

    start, dest = S + "aisle-1-back", S + "checkout"
    script = iter([
        AIMessage(content="", tool_calls=[{"id": "1", "name": "resolve_destination", "args": {"name": "Checkout"}}]),
        AIMessage(content="", tool_calls=[{"id": "2", "name": "plan_navigation", "args": {"start_id": start, "destination_id": dest}}]),
        AIMessage(content="", tool_calls=[{"id": "3", "name": "create_arrow_instructions", "args": {"from_sweep_id": start, "to_sweep_id": dest}}]),
        AIMessage(content=[{"type": "thinking", "thinking": "PRIVATE REASONING", "signature": "s"},
                           {"type": "text", "text": "Checkout is one step ahead."}]),
    ])
    real_build = agent_module.build_navigation_agent
    monkeypatch.setattr(agent_module, "build_navigation_agent", lambda **kw: real_build(model=Scripted(messages=script)))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "dummy-not-used")
    monkeypatch.setenv(demo.ENV_FILE_OVERRIDE_VAR, "/nonexistent/.env")

    demo.main(["--sample", "--start", start, "Take me to checkout"])
    out = capsys.readouterr().out
    assert "Mode: agent" in out and "Prompt sent: I am at sweep" in out
    assert "1. resolve_destination" in out and "3. create_arrow_instructions  [STEP]" in out
    assert f"Next arrow: {start} -> {dest}   [STEP]" in out
    assert "matches the deterministic route" in out
    assert "Checkout is one step ahead." in out
    assert "PRIVATE REASONING" not in out and "dummy-not-used" not in out
