"""Demo configuration: .env loading, missing credentials, provider errors, and no secret leakage.

Provider errors come from a local fake HTTP server, so nothing leaves the machine and nothing is billed.
"""

import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from matterport_agent import demo
from matterport_agent.sample_data import build_sample_model

PROJECT_DIR = Path(__file__).resolve().parent.parent
FAKE_KEY = "sk-ant-FAKE-test-key-must-never-be-printed-0123456789"


def run_demo(args, env_overrides, cwd=PROJECT_DIR):
    # Clean environment and a non-existent .env: a real key in matterport_agent/.env is never used here.
    env = {"PATH": "/usr/bin:/bin", "HOME": str(PROJECT_DIR),
           demo.ENV_FILE_OVERRIDE_VAR: str(PROJECT_DIR / "tests" / "no-such.env"), **env_overrides}
    return subprocess.run(
        [sys.executable, "-m", "matterport_agent.demo", *args],
        cwd=cwd, env=env, capture_output=True, text=True, timeout=120,
    )


class FakeAnthropic(BaseHTTPRequestHandler):
    status = 401

    def _reply(self):
        body = json.dumps({"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}})
        self.send_response(self.status)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(body.encode())

    do_GET = do_POST = _reply

    def log_message(self, *args):
        pass


@pytest.fixture
def fake_server(request):
    handler = type("Handler", (FakeAnthropic,), {"status": getattr(request, "param", 401)})
    server = HTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()      # stop serve_forever
    server.server_close()  # close the listening socket (otherwise: ResourceWarning: unclosed socket)
    thread.join(timeout=5)


def test_env_file_path_is_fixed_to_project_folder():
    assert demo.ENV_FILE == PROJECT_DIR / ".env"


def test_env_file_is_loaded_without_overriding_shell(tmp_path, monkeypatch, capsys):
    env_file = tmp_path / ".env"
    env_file.write_text(f"ANTHROPIC_API_KEY={FAKE_KEY}\nMATTERPORT_ARROW_VERTICAL_OFFSET_M=0.3\nMATTERPORT_AGENT_MODEL=anthropic:from-file\n")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("MATTERPORT_ARROW_VERTICAL_OFFSET_M", raising=False)
    monkeypatch.setenv("MATTERPORT_AGENT_MODEL", "anthropic:from-shell")

    assert demo.load_env_file(env_file)
    import os

    assert os.environ["ANTHROPIC_API_KEY"] == FAKE_KEY
    assert os.environ["MATTERPORT_AGENT_MODEL"] == "anthropic:from-shell"  # shell wins
    assert FAKE_KEY not in capsys.readouterr().err
    monkeypatch.delenv("ANTHROPIC_API_KEY")


def test_arrow_offset_from_env_is_applied(monkeypatch):
    monkeypatch.setenv("MATTERPORT_ARROW_VERTICAL_OFFSET_M", "0.3")
    args = demo.argparse.Namespace(arrow_offset=None, floor_height=[])
    assert demo.build_session(args, build_sample_model()).arrow_config.vertical_offset_m == 0.3


def test_missing_key_gives_clear_error(tmp_path):
    result = run_demo(["--sample", "Take me to checkout"], {"ANTHROPIC_API_KEY": ""})
    assert result.returncode != 0
    assert "ANTHROPIC_API_KEY is not set" in result.stderr
    assert ".env" in result.stderr and "--offline" in result.stderr
    assert "Traceback" not in result.stderr


@pytest.mark.parametrize("args", [["--sample", "Take me to checkout"], ["--check-model"]])
def test_rejected_key_gives_clear_error_and_is_never_printed(fake_server, args):
    result = run_demo(args, {"ANTHROPIC_API_KEY": FAKE_KEY, "ANTHROPIC_BASE_URL": fake_server})
    assert result.returncode != 0
    assert "rejected the API key" in result.stderr
    assert "Traceback" not in result.stderr
    assert FAKE_KEY not in result.stdout + result.stderr
    assert FAKE_KEY[-12:] not in result.stdout + result.stderr


@pytest.mark.parametrize("fake_server", [404], indirect=True)
def test_unknown_model_gives_clear_error(fake_server):
    result = run_demo(["--check-model"], {"ANTHROPIC_API_KEY": FAKE_KEY, "ANTHROPIC_BASE_URL": fake_server,
                                          "MATTERPORT_AGENT_MODEL": "anthropic:claude-not-a-model"})
    assert "doesn't recognize model anthropic:claude-not-a-model" in result.stderr
    assert FAKE_KEY not in result.stdout + result.stderr


def test_offline_demo_needs_no_key():
    result = run_demo(["--sample", "Checkout", "--offline", "--json", "--start", "SAMPLE-sweep-aisle-1-back"], {})
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["route"]["status"] == "ROUTE"


def test_no_data_choice_is_an_error_not_a_silent_sample():
    result = run_demo(["Checkout", "--offline"], {})
    assert result.returncode != 0
    assert "No sweep data chosen" in result.stderr and "--sample" in result.stderr
    assert "SAMPLE" not in result.stdout
