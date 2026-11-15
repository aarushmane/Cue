"""Small Matterport Model API client, adapted from the HackPrinceton 2026 quickstart.

Keys are read from the environment or a git-ignored .env file next to this script:
    MATTERPORT_API_KEY    (HTTP basic auth user name)
    MATTERPORT_API_TOKEN  (HTTP basic auth password)
"""
import io
import os
from pathlib import Path

import requests

API = "https://api.matterport.com/api/models/graph"  # production only; the hackathon keys fail elsewhere
HERE = Path(__file__).resolve().parent


class MatterportError(RuntimeError):
    pass


def secret(name, required=True):
    """Read a key from the environment, then from .env.local or .env. Never prints it."""
    value = os.environ.get(name)
    for env in (HERE / ".env.local", HERE / ".env"):
        if value or not env.exists():
            continue
        for line in env.read_text(encoding="utf-8").splitlines():
            k, _, v = line.partition("=")
            if k.strip() == name:
                value = v.strip().strip('"').strip("'")
    if not value and required:
        raise SystemExit(f"{name} is not set. Put it in .env.local (see .env.example).")
    return value


_session = None


def session():
    global _session
    if _session is None:
        _session = requests.Session()
        _session.auth = (secret("MATTERPORT_API_KEY"), secret("MATTERPORT_API_TOKEN"))
    return _session


def graph(query, **variables):
    """Run a Model API GraphQL query and return its `data`."""
    r = session().post(API, json={"query": query, "variables": variables}, timeout=120)
    if r.status_code in (401, 403):
        raise MatterportError(f"Matterport rejected the key (HTTP {r.status_code}). Check MATTERPORT_API_KEY / "
                              f"MATTERPORT_API_TOKEN in .env (key = user, token = password).")
    r.raise_for_status()
    body = r.json()
    for e in body.get("errors") or []:
        if (e.get("extensions") or {}).get("code") == "not.found":
            raise MatterportError(f"{variables} not found, or not shared with your key.")
        raise MatterportError(f"GraphQL error: {e.get('message')}")
    return body["data"]


def fetch(url, start=None, end=None):
    """GET bytes, optionally a byte range (inclusive). Signed URLs need no auth."""
    headers = {}
    if start is not None or end is not None:
        headers["Range"] = f"bytes={start or 0}-{'' if end is None else end}"
    r = requests.get(url, headers=headers, timeout=300)
    r.raise_for_status()
    return r.content


class HttpFile(io.RawIOBase):
    """Read-only, seekable file over HTTP range requests, so zipfile can read single members of a remote zip."""

    def __init__(self, url, block=8 * 2**20):
        self.url, self.pos, self.block, self.buf, self.buf_at = url, 0, block, b"", -1
        r = requests.get(url, headers={"Range": "bytes=0-0"}, timeout=60)
        r.raise_for_status()
        self.size = int(r.headers["Content-Range"].split("/")[1])

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = {0: off, 1: self.pos + off, 2: self.size + off}[whence]
        return self.pos

    def read(self, n=-1):
        n = self.size - self.pos if n is None or n < 0 else min(n, self.size - self.pos)
        if n <= 0:
            return b""
        if not (self.buf_at <= self.pos and self.pos + n <= self.buf_at + len(self.buf)):
            self.buf_at = self.pos
            self.buf = fetch(self.url, self.pos, min(self.size, self.pos + max(n, self.block)) - 1)
        out = self.buf[self.pos - self.buf_at: self.pos - self.buf_at + n]
        self.pos += len(out)
        return out

    def readinto(self, b):
        data = self.read(len(b))
        b[:len(data)] = data
        return len(data)
