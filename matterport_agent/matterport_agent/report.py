"""Readable terminal reports for demo runs, with or without the language model.

Shows each tool call (name, input, result), the route, and the next arrow. For agent runs it
prints only the final answer's text blocks; thinking/reasoning blocks are never printed.
Nothing here reads environment variables, so no secret can end up in a report.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any, Iterable

from . import routing
from .arrows import create_arrow_instructions
from .context import NavigationSession
from .tools import create_arrow_instructions as arrow_tool
from .tools import plan_navigation as plan_tool
from .tools import resolve_destination as resolve_tool

ERROR_STATUSES = {"UNKNOWN_DESTINATION", "UNKNOWN_START", "UNREACHABLE", "UNKNOWN_SWEEP", "NOT_CONNECTED"}
MAX_RESULT_CHARS = 700


@dataclass(frozen=True)
class ToolEvent:
    name: str
    args: dict[str, Any]
    result: Any
    """Parsed JSON for our tools; a string for Deep Agents' built-in tools."""


# --- collecting events ---------------------------------------------------------------------


def run_tools_offline(session: NavigationSession, destination: str, start: str) -> list[ToolEvent]:
    """Call the same LangChain tool functions the agent uses, in the order the agent is told to."""
    runtime = SimpleNamespace(context=session)
    events: list[ToolEvent] = []

    def call(tool, **args):
        result = tool.func(**args, runtime=runtime)
        events.append(ToolEvent(tool.name, args, result))
        return result

    resolved = call(resolve_tool, name=destination)
    if resolved.get("status") != "MATCH":
        return events
    plan = call(plan_tool, start_id=start, destination_id=resolved["sweep_id"])
    ids = plan.get("sweep_ids") or []
    if plan.get("status") == "ARRIVED":
        call(arrow_tool, from_sweep_id=ids[0], to_sweep_id=ids[0])
    for a, b in zip(ids, ids[1:]):
        call(arrow_tool, from_sweep_id=a, to_sweep_id=b)
    return events


def _parse(content: Any) -> Any:
    if isinstance(content, str):
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            return content
    return content


def events_from_messages(messages: Iterable[Any]) -> list[ToolEvent]:
    """Pair each AI tool call with its ToolMessage result, in call order."""
    results = {getattr(m, "tool_call_id", None): m.content for m in messages if getattr(m, "type", "") == "tool"}
    events = []
    for m in messages:
        for call in getattr(m, "tool_calls", None) or []:
            events.append(ToolEvent(call["name"], dict(call.get("args") or {}), _parse(results.get(call.get("id"), "(no result)"))))
    return events


def final_answer_text(message: Any) -> str:
    """Visible text of the agent's final message. Thinking and other non-text blocks are dropped."""
    content = getattr(message, "content", "")
    if isinstance(content, str):
        return content.strip()
    parts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
    return "\n".join(p.strip() for p in parts if p.strip())


# --- formatting ----------------------------------------------------------------------------


def _compact(value: Any, full: bool) -> str:
    text = json.dumps(value, separators=(", ", ": ")) if not isinstance(value, str) else value
    if not full and len(text) > MAX_RESULT_CHARS:
        return text[:MAX_RESULT_CHARS] + f" … ({len(text)} chars; use --full-results to see all)"
    return text


def _status(result: Any) -> str | None:
    return result.get("status") if isinstance(result, dict) else None


def _vec(p: dict | None, keys: str = "xyz") -> str:
    return "none" if p is None else "(" + ", ".join(f"{p[k]:.3f}" for k in keys) + ")"


def format_tool_events(events: list[ToolEvent], full: bool = False) -> list[str]:
    lines = ["Tool calls:"]
    if not events:
        lines.append("  (none)")
    for i, e in enumerate(events, 1):
        status = _status(e.result)
        flag = f"  !! {status}" if status in ERROR_STATUSES else (f"  [{status}]" if status else "")
        lines.append(f"  {i}. {e.name}{flag}")
        lines.append(f"     input:  {json.dumps(e.args)}")
        lines.append(f"     result: {_compact(e.result, full)}")
        if status in ERROR_STATUSES and isinstance(e.result, dict) and e.result.get("reason"):
            lines.append(f"     reason: {e.result['reason']}")
    return lines


def last_plan(events: list[ToolEvent]) -> dict | None:
    plans = [e.result for e in events if e.name == "plan_navigation" and isinstance(e.result, dict)]
    return plans[-1] if plans else None


def format_route(plan: dict | None) -> list[str]:
    if plan is None:
        return ["Route: no plan_navigation call was made."]
    status = plan.get("status")
    if status == "ROUTE":
        ids = plan["sweep_ids"]
        lines = [f"Route: {len(ids) - 1} step(s), {plan['total_distance_m']:.2f} m total"]
        for i, sid in enumerate(ids):
            step = plan["steps"][i - 1] if i else None
            note = ""
            if step and step["floor_transition"] == "FLOOR_CHANGE":
                note = f"   <- floor change ({step['from_floor_id']} -> {step['to_floor_id']})"
            lines.append(f"  {i:>3}. {sid}{note}")
        return lines
    if status == "ARRIVED":
        return [f"Route: already at the destination ({plan['start_sweep_id']})."]
    return [f"Route: !! {status}: {plan.get('reason') or ''}".rstrip()]


def next_arrow(events: list[ToolEvent], plan: dict | None) -> tuple[dict | None, str]:
    """The arrow for the first step of the route: (arrow, where it came from)."""
    if not plan or plan.get("status") not in {"ROUTE", "ARRIVED"}:
        return None, "no route"
    ids = plan["sweep_ids"]
    a, b = (ids[0], ids[1]) if len(ids) > 1 else (ids[0], ids[0])
    for e in events:
        if e.name == "create_arrow_instructions" and e.args.get("from_sweep_id") == a and e.args.get("to_sweep_id") == b:
            return e.result, "create_arrow_instructions tool result"
    return None, "missing"


def format_arrow(arrow: dict | None, source: str, session: NavigationSession, plan: dict | None) -> list[str]:
    if arrow is None and source == "missing" and plan:
        ids = plan["sweep_ids"]
        a, b = (ids[0], ids[1]) if len(ids) > 1 else (ids[0], ids[0])
        computed = create_arrow_instructions(session.model_data, a, b, session.arrow_config).model_dump(mode="json")
        return ["Next arrow: !! the agent did not call create_arrow_instructions for the first step.",
                "  Computed directly by the demo for comparison (not from the agent):",
                *format_arrow(computed, "demo", session, plan)[1:]]
    if arrow is None:
        return [f"Next arrow: none ({source})."]
    status = arrow.get("status")
    if status in ERROR_STATUSES:
        return [f"Next arrow: !! {status}: {arrow.get('reason')}"]
    anchor, target_floor = arrow["anchor"], arrow["target_floor"]
    lines = [
        f"Next arrow: {arrow['source_sweep_id']} -> {arrow['target_sweep_id']}   [{status}]",
        f"  coordinates:   {arrow['coordinate_system']} (meters, Y up), model {arrow['model_id']}",
        f"  anchor:        {_vec(anchor['position'])}   from {anchor['source']}",
        f"  target sweep:  {_vec(arrow['target_position'])}",
        f"  target floor:  {_vec(target_floor['position'])}   from {target_floor['source']}",
    ]
    if arrow["direction"]:
        lines.append(f"  direction:     {_vec(arrow['direction'], 'xz')} on X/Z, {arrow['horizontal_distance_m']:.2f} m horizontal")
    else:
        lines.append(f"  direction:     none ({arrow['direction_status']})")
    delta = arrow["floor_sequence_delta"]
    lines.append(f"  floor:         {arrow['floor_transition']}" + (f" ({delta:+d})" if delta not in (None, 0) else ""))
    lines.append(f"  offset:        {arrow['vertical_offset_m']} m above floor")
    if arrow["needs_floor_height"]:
        lines.append("  !! needs a floor height: no puck position here. Pass --floor-height FLOOR_ID=Y to place it.")
    return lines


def format_consistency(events: list[ToolEvent], session: NavigationSession, start: str) -> list[str]:
    """Agent runs: compare the agent's plan with a fresh deterministic plan for the same request."""
    plan = last_plan(events)
    if plan is None or plan.get("status") not in {"ROUTE", "ARRIVED"}:
        return []
    expected = routing.plan_navigation(session.model_data, start, plan["destination_sweep_id"]).to_dict()
    same = plan.get("start_sweep_id") == start and plan.get("sweep_ids") == expected["sweep_ids"]
    if same:
        return ["Check: the agent's route matches the deterministic route from your start sweep."]
    return ["Check: !! the agent's route differs from the deterministic route from your start sweep.",
            f"  agent start {plan.get('start_sweep_id')}, expected start {start}"]
