"""Command-line demo for the navigation agent.

Run from the matterport_agent/ folder (the one containing .env.example).

Pick the data explicitly. There is no silent fallback to fake data:
    --data data/store-sweeps.json   a real export from exporter/index.html
                                    (or set MATTERPORT_SWEEPS_FILE in .env)
    --sample                        the made-up SAMPLE model, for trying things out

Examples:
    python -m matterport_agent.demo --data data/store-sweeps.json --list-sweeps          # what's in the file
    python -m matterport_agent.demo --data data/store-sweeps.json "Checkout" --offline   # no AI, free
    python -m matterport_agent.demo --data data/store-sweeps.json "Take me to checkout"  # real agent, paid
    python -m matterport_agent.demo --check-model                                        # free Models API lookup

Settings are read from matterport_agent/.env (if present), then the shell environment.
A variable already set in the shell wins over .env. Secret values are never printed.

Options:
    --start SWEEP_ID          current sweep (default: start_sweep_id from the export)
    --arrow-offset METERS     arrow height above the floor (default env
                              MATTERPORT_ARROW_VERTICAL_OFFSET_M, else 0.05)
    --floor-height ID=Y       floor height for sweeps without a puck position (repeatable)
    --json                    machine-readable output instead of the report
    --full-results            don't shorten long tool results in the report
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from . import arrows, report
from .agent import MODEL_ENV_VAR, resolve_model
from .context import NavigationSession
from .models import ModelNavigationData
from .real_data import ExportError, LoadedExport, load_export
from .sample_data import build_sample_model

OFFSET_ENV_VAR = "MATTERPORT_ARROW_VERTICAL_OFFSET_M"
SWEEPS_FILE_ENV_VAR = "MATTERPORT_SWEEPS_FILE"
KEY_ENV_VAR = "ANTHROPIC_API_KEY"
PROJECT_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = PROJECT_DIR / ".env"
"""Always matterport_agent/.env, wherever the command is run from."""
ENV_FILE_OVERRIDE_VAR = "MATTERPORT_AGENT_ENV_FILE"
"""Tests point this at a missing file so they can never pick up a real key."""
SAMPLE_DEFAULT_START = "SAMPLE-sweep-entrance"


def load_env_file(path: Path | None = None) -> bool:
    """Load KEY=value lines from `path` without overriding the shell. Reports the path, never values."""
    if path is None:
        path = Path(os.environ[ENV_FILE_OVERRIDE_VAR]) if os.environ.get(ENV_FILE_OVERRIDE_VAR) else ENV_FILE
    if not path.is_file():
        print(f"No .env file at {path}; using shell environment only.", file=sys.stderr)
        return False
    from dotenv import load_dotenv

    load_dotenv(path, override=False)
    print(f"Loaded settings from {path}", file=sys.stderr)
    return True


def require_anthropic_key(model: Any) -> None:
    """Fail early, with instructions, if the anthropic provider has no key. Never prints the key."""
    if isinstance(model, str) and model.startswith("anthropic:") and not os.environ.get(KEY_ENV_VAR, "").strip():
        raise SystemExit(
            f"{KEY_ENV_VAR} is not set (or is empty).\n"
            f"Put it in {ENV_FILE} as {KEY_ENV_VAR}=... (copy .env.example first), "
            f"or export it in your shell. Or run with --offline for a free demo."
        )


def explain_api_error(error: Exception, model: Any) -> str | None:
    """Plain-language message for common provider errors. Uses our own text, not the response body."""
    import anthropic

    status = getattr(error, "status_code", None)
    if isinstance(error, anthropic.AuthenticationError):
        return f"The provider rejected the API key (HTTP {status}). Check {KEY_ENV_VAR} in {ENV_FILE}."
    if isinstance(error, anthropic.PermissionDeniedError):
        return f"The API key isn't allowed to use {model} (HTTP {status}). Check your account's model access."
    if isinstance(error, anthropic.NotFoundError):
        return f"The provider doesn't recognize model {model} (HTTP {status}). Set {MODEL_ENV_VAR} to a supported model."
    if isinstance(error, anthropic.RateLimitError):
        return f"Rate limited or out of credit (HTTP {status}). Check usage and billing in the Claude Console."
    if isinstance(error, anthropic.APIConnectionError):
        return "Couldn't reach the provider. Check your network connection."
    return None


# --- data and session ----------------------------------------------------------------------


def choose_data(args: argparse.Namespace) -> tuple[ModelNavigationData, LoadedExport | None, list[str]]:
    """Real export or explicit sample. Returns (data, loaded export or None, header lines)."""
    if args.sample:
        lines = ["Data: SAMPLE model (made-up IDs and coordinates, for testing only; not your store)."]
        return build_sample_model(), None, lines

    raw_path = args.data or os.environ.get(SWEEPS_FILE_ENV_VAR, "").strip()
    if not raw_path:
        raise SystemExit(
            "No sweep data chosen. Use one of:\n"
            "  --data data/store-sweeps.json   (a real export from exporter/index.html)\n"
            f"  {SWEEPS_FILE_ENV_VAR}=data/store-sweeps.json in .env\n"
            "  --sample                        (made-up test data)"
        )
    path = Path(raw_path)
    if not path.is_absolute():
        path = (Path.cwd() / path) if (Path.cwd() / path).exists() else (PROJECT_DIR / path)
    try:
        loaded = load_export(path)
    except ExportError as e:
        raise SystemExit(f"Can't use the sweep export.\n{e}") from None

    d = loaded.data
    lines = [
        f"Data: REAL export {loaded.path}",
        f"  model {d.model_id}, {loaded.total_sweeps} sweeps, exported {loaded.exported_at}, IDs from {loaded.sweep_id_field!r}",
        f"  {len(d.sweeps)} enabled sweeps used for routing"
        + (f"; {len(loaded.disabled_sweep_ids)} disabled sweeps and {loaded.dropped_connections} connections into them left out"
           if loaded.disabled_sweep_ids else ""),
        f"  {loaded.sweeps_without_puck} sweeps without a puck position, {loaded.sweeps_without_floor} without floor info",
        "  destinations: " + (", ".join(x.name for x in d.destinations) or "none labeled"),
    ]
    return d, loaded, lines


def _parse_floor_heights(items: list[str]) -> dict[str, float]:
    heights: dict[str, float] = {}
    for item in items:
        floor_id, sep, value = item.partition("=")
        if not sep or not floor_id:
            raise SystemExit(f"--floor-height expects FLOOR_ID=Y, got {item!r}")
        heights[floor_id] = float(value)
    return heights


def build_session(args: argparse.Namespace, model_data: ModelNavigationData) -> NavigationSession:
    offset = args.arrow_offset
    if offset is None:
        offset = float(os.environ.get(OFFSET_ENV_VAR) or 0.05)
    config = arrows.ArrowConfig(vertical_offset_m=offset, floor_heights_m=_parse_floor_heights(args.floor_height))
    return NavigationSession(model_data=model_data, arrow_config=config)


def choose_start(args: argparse.Namespace, data: ModelNavigationData, loaded: LoadedExport | None) -> str:
    start = args.start or (loaded.start_sweep_id if loaded else SAMPLE_DEFAULT_START)
    if not start:
        raise SystemExit("No start sweep. Pass --start SWEEP_ID, or set a starting point in the exporter. "
                         "Use --list-sweeps to see the IDs.")
    if start not in data.sweeps:
        if loaded and start in loaded.disabled_sweep_ids:
            raise SystemExit(f"Start sweep {start} is disabled in this space, so it can't be navigated from.")
        raise SystemExit(f"Start sweep {start} isn't in model {data.model_id}. Use --list-sweeps to see the IDs.")
    return start


def list_sweeps(data: ModelNavigationData, loaded: LoadedExport | None) -> None:
    print("Destinations:")
    for d in data.destinations:
        print(f"  {d.name} -> {d.sweep_id}" + (f"   (also: {', '.join(d.aliases)})" if d.aliases else ""))
    if not data.destinations:
        print("  none labeled")
    if loaded:
        print(f"Start in export: {loaded.start_sweep_id or 'not set'}")
    print("Sweeps (id | floor | puck | outgoing connections):")
    for s in sorted(data.sweeps.values(), key=lambda s: ((s.floor.sequence if s.floor else -1), s.sweep_id)):
        floor = f"{s.floor.id} (#{s.floor.sequence})" if s.floor else "unknown"
        print(f"  {s.sweep_id} | {floor} | {'yes' if s.puck_position else 'no'} | {len(s.neighbor_ids)}")


# --- runs ----------------------------------------------------------------------------------


def _print_report(header: list[str], start: str, events, session: NavigationSession, full: bool, extra=()) -> None:
    plan = report.last_plan(events)
    arrow, source = report.next_arrow(events, plan)
    out = [*header, f"Start sweep: {start}", "", *report.format_tool_events(events, full), "",
           *report.format_route(plan), "", *report.format_arrow(arrow, source, session, plan), *extra]
    print("\n".join(out))


def _json_output(header: list[str], start: str, events, mode: str, answer: str | None = None) -> None:
    plan = report.last_plan(events)
    arrow, source = report.next_arrow(events, plan)
    print(json.dumps({
        "mode": mode, "data": header, "start_sweep_id": start,
        "tool_calls": [{"name": e.name, "input": e.args, "result": e.result} for e in events],
        "route": plan, "next_arrow": arrow, "next_arrow_source": source, "agent_answer": answer,
    }, indent=2))


def run_offline(args, session: NavigationSession, start: str, header: list[str]) -> None:
    events = report.run_tools_offline(session, args.question, start)
    if args.json:
        _json_output(header, start, events, "offline")
    else:
        _print_report(["Mode: offline (no AI): the demo calls the tools itself.", *header],
                      start, events, session, args.full_results)


def check_model() -> None:
    """Ask the provider whether the configured model exists for this key. Models API calls aren't billed."""
    model = resolve_model()
    print(f"Model: {model} (set {MODEL_ENV_VAR} to change)", file=sys.stderr)
    if not (isinstance(model, str) and model.startswith("anthropic:")):
        raise SystemExit("--check-model only knows how to check the anthropic provider.")
    require_anthropic_key(model)
    import anthropic

    model_id = model.removeprefix("anthropic:")
    try:
        info = anthropic.Anthropic().models.retrieve(model_id)
    except anthropic.APIError as error:
        raise SystemExit(explain_api_error(error, model) or f"Provider error: {type(error).__name__}") from None
    print(f"OK: provider recognizes {info.id} ({info.display_name}), max output {info.max_tokens} tokens.")


def run_agent(args, session: NavigationSession, start: str, header: list[str]) -> None:
    import anthropic

    from .agent import build_navigation_agent

    model = resolve_model()
    require_anthropic_key(model)
    prompt = f"I am at sweep {start}. {args.question}"
    print(f"Model: {model} (set {MODEL_ENV_VAR} to change). Calling the agent…", file=sys.stderr)
    agent = build_navigation_agent()
    try:
        result = agent.invoke({"messages": [{"role": "user", "content": prompt}]}, context=session)
    except anthropic.APIError as error:
        message = explain_api_error(error, model)
        if message is None:
            raise
        raise SystemExit(message) from None

    events = report.events_from_messages(result["messages"])
    answer = report.final_answer_text(result["messages"][-1])
    if args.json:
        _json_output(header, start, events, "agent", answer)
        return
    _print_report(
        [f"Mode: agent ({model}): the model chose which tools to call.", *header, f"Prompt sent: {prompt}"],
        start, events, session, args.full_results,
        extra=["", *report.format_consistency(events, session, start), "", "Agent answer:", answer or "(no text)"],
    )


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Navigation agent demo. Choose --data (real export) or --sample.")
    parser.add_argument("question", nargs="?", help='Agent mode: what the user says. --offline: a destination name, e.g. "Checkout".')
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--data", metavar="FILE", help=f"Real sweep export JSON (or set {SWEEPS_FILE_ENV_VAR}).")
    source.add_argument("--sample", action="store_true", help="Use the made-up SAMPLE model.")
    parser.add_argument("--start", default=None)
    parser.add_argument("--offline", action="store_true", help="Run the tools directly, no model call.")
    parser.add_argument("--list-sweeps", action="store_true", help="Print destinations and sweep IDs, then exit.")
    parser.add_argument("--check-model", action="store_true", help="Check the configured model with the provider (free).")
    parser.add_argument("--arrow-offset", type=float, default=None)
    parser.add_argument("--floor-height", action="append", default=[], metavar="FLOOR_ID=Y")
    parser.add_argument("--json", action="store_true", help="Machine-readable output.")
    parser.add_argument("--full-results", action="store_true", help="Don't shorten long tool results.")
    args = parser.parse_args(argv)

    load_env_file()  # before reading any setting, including the arrow offset and data file
    if args.check_model:
        check_model()
        return

    data, loaded, header = choose_data(args)
    if args.list_sweeps:
        print("\n".join(header))
        list_sweeps(data, loaded)
        return
    if not args.question:
        parser.error("a question is required (or use --list-sweeps / --check-model)")

    start = choose_start(args, data, loaded)
    session = build_session(args, data)
    if args.offline:
        run_offline(args, session, start, header)
    else:
        run_agent(args, session, start, header)


if __name__ == "__main__":
    main()
