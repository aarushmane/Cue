"""Loading a real-format export. The IDs below are made up but shaped like exporter output
(no SAMPLE prefix, so they exercise the real-data path)."""

import copy
import json
import subprocess
import sys
from pathlib import Path

import pytest

from matterport_agent.real_data import ExportError, load_export
from matterport_agent.routing import PlanStatus, plan_navigation

PROJECT_DIR = Path(__file__).resolve().parent.parent


def sweep(sid, x, z, neighbors, *, floor=("f0", 0), puck=True, enabled=True, y=1.5):
    return {
        "sweep_id": sid, "id": sid, "sid": f"s-{sid}", "uuid": f"u-{sid}", "enabled": enabled,
        "alignment_type": "aligned", "placement_type": "auto",
        "position": {"x": x, "y": y, "z": z},
        "puck_position": {"x": x, "y": y - 1.5, "z": z} if puck else None,
        "floor": {"id": floor[0], "sequence": floor[1]} if floor else None,
        "neighbors": neighbors,
    }


BASE = {
    "format": "storeguide.matterport-sweeps", "format_version": 1, "exported_at": "2026-11-14T12:00:00Z",
    "sdk_version": "3.1.0-0-g1cd7e0997a", "model_id": "abcDEF12345", "coordinate_system": "MATTERPORT_SDK_WORLD",
    "sweep_id_field": "id", "start_sweep_id": "a1",
    "destinations": [{"name": "Checkout", "sweep_id": "c3", "aliases": ["registers"]}],
    "sweeps": [
        sweep("a1", 0, 0, ["b2"]),
        sweep("b2", 2, 0, ["a1", "c3", "off9"]),
        sweep("c3", 2, -3, ["b2"], puck=False),
        sweep("off9", 5, 5, ["b2"], enabled=False),
        sweep("lone7", 9, 9, [], floor=None),
    ],
}


def write(tmp_path, doc, name="export.json"):
    path = tmp_path / name
    path.write_text(json.dumps(doc))
    return path


def mutated(**changes):
    doc = copy.deepcopy(BASE)
    doc.update(changes)
    return doc


def test_valid_export_loads_as_real_data(tmp_path):
    loaded = load_export(write(tmp_path, BASE))
    d = loaded.data
    assert not d.is_sample and d.model_id == "abcDEF12345"
    assert set(d.sweeps) == {"a1", "b2", "c3", "lone7"}           # disabled sweep left out of routing
    assert d.sweeps["b2"].neighbor_ids == ("a1", "c3")            # and so is the connection into it
    assert loaded.disabled_sweep_ids == ("off9",) and loaded.dropped_connections == 1
    assert d.sweeps["c3"].puck_position is None and d.sweeps["lone7"].floor is None
    assert loaded.start_sweep_id == "a1"
    assert d.find_destination("registers").sweep_id == "c3"
    assert plan_navigation(d, "a1", "c3").sweep_ids == ("a1", "b2", "c3")
    assert plan_navigation(d, "a1", "lone7").status is PlanStatus.UNREACHABLE


@pytest.mark.parametrize(
    ("doc", "message"),
    [
        (mutated(model_id="SAMPLE-MODEL-local-test"), "reserved for fake test data"),
        (mutated(applicationKey="should-not-be-here"), "Extra inputs are not permitted"),
        (mutated(format_version=2), "format_version 2"),
        (mutated(sweeps=[sweep("a1", 0, 0, ["ghost"])], start_sweep_id=None, destinations=[]), "aren't sweeps in this file"),
        (mutated(destinations=[{"name": "Back room", "sweep_id": "off9", "aliases": []}]), "disabled sweep"),
        (mutated(start_sweep_id="nope"), "start_sweep_id nope"),
        (mutated(sweeps=[sweep("a1", 0, 0, []), sweep("a1", 1, 0, [])], start_sweep_id=None, destinations=[]), "duplicate sweep IDs"),
    ],
)
def test_invalid_exports_are_rejected_with_a_reason(tmp_path, doc, message):
    with pytest.raises(ExportError, match=message):
        load_export(write(tmp_path, doc))


def test_non_finite_coordinates_are_rejected(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text(json.dumps(BASE).replace('"x": 2, "y": 1.5, "z": -3', '"x": NaN, "y": 1.5, "z": -3'))
    with pytest.raises(ExportError, match="position"):
        load_export(path)


def test_missing_and_malformed_files(tmp_path):
    with pytest.raises(ExportError, match="not found"):
        load_export(tmp_path / "missing.json")
    (tmp_path / "broken.json").write_text("{not json")
    with pytest.raises(ExportError, match="not valid JSON"):
        load_export(tmp_path / "broken.json")


def run_demo(args):
    env = {"PATH": "/usr/bin:/bin", "HOME": str(PROJECT_DIR), "MATTERPORT_AGENT_ENV_FILE": str(PROJECT_DIR / "tests" / "no-such.env")}
    return subprocess.run([sys.executable, "-m", "matterport_agent.demo", *args], cwd=PROJECT_DIR, env=env,
                          capture_output=True, text=True, timeout=120)


def test_offline_report_on_real_export(tmp_path):
    result = run_demo(["--data", str(write(tmp_path, BASE)), "Checkout", "--offline", "--floor-height", "f0=0.0"])
    assert result.returncode == 0, result.stderr
    out = result.stdout
    assert "Data: REAL export" in out and "SAMPLE" not in out
    for expected in ["1. resolve_destination", "2. plan_navigation", "3. create_arrow_instructions",
                     "Route: 2 step(s)", "Next arrow: a1 -> b2   [STEP]", "anchor:        (0.000, 0.050, 0.000)   from PUCK",
                     "direction:     (1.000, 0.000) on X/Z"]:
        assert expected in out, expected


def test_offline_report_shows_errors_clearly(tmp_path):
    path = write(tmp_path, BASE)
    unknown = run_demo(["--data", str(path), "Bakery", "--offline"])
    assert "!! UNKNOWN_DESTINATION" in unknown.stdout
    unreachable_doc = mutated(destinations=[{"name": "Lone", "sweep_id": "lone7", "aliases": []}])
    unreachable = run_demo(["--data", str(write(tmp_path, unreachable_doc, "u.json")), "Lone", "--offline"])
    assert "!! UNREACHABLE" in unreachable.stdout and "Route: !! UNREACHABLE" in unreachable.stdout


def test_bad_export_stops_the_demo(tmp_path):
    result = run_demo(["--data", str(write(tmp_path, mutated(model_id="SAMPLE-x"))), "Checkout", "--offline"])
    assert result.returncode != 0 and "Can't use the sweep export" in result.stderr


def test_list_sweeps(tmp_path):
    result = run_demo(["--data", str(write(tmp_path, BASE)), "--list-sweeps"])
    assert result.returncode == 0, result.stderr
    assert "Checkout -> c3" in result.stdout and "a1 | f0 (#0) | yes | 1" in result.stdout
