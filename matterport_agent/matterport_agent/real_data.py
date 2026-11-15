"""Load and validate a real Matterport sweep export (written by exporter/index.html).

Strict on purpose: anything inconsistent stops with an ExportError that says what's wrong.
Nothing is repaired, guessed, or filled in, and sample data is never substituted.

Rules:
  - The file must match the export format exactly (unknown fields are rejected, so a stray
    "applicationKey" or other secret can't ride along unnoticed).
  - Sweep IDs come from the field the exporter recorded in `sweep_id_field`.
  - Every neighbor must be a sweep in the same file. Connections stay one-way as exported.
  - Disabled sweeps (enabled=false) are kept in the report but left out of routing, together
    with every connection into them. Destinations and the start must be enabled sweeps.
  - IDs that start with "SAMPLE" are reserved for fake data and are rejected here.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .models import Destination, FloorInfo, ModelNavigationData, NavigationDataError, Sweep, Vector3

EXPORT_FORMAT = "storeguide.matterport-sweeps"
SUPPORTED_VERSIONS = {1}


class ExportError(ValueError):
    """The export file can't be used. The message is meant for the person running the demo."""


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class _Vec(_Strict):
    x: float = Field(allow_inf_nan=False)
    y: float = Field(allow_inf_nan=False)
    z: float = Field(allow_inf_nan=False)


class _Floor(_Strict):
    id: str = Field(min_length=1)
    sequence: int = Field(ge=0)


class _Sweep(_Strict):
    sweep_id: str = Field(min_length=1)
    id: str | None
    sid: str | None
    uuid: str | None
    enabled: bool
    alignment_type: str | None
    placement_type: str | None
    position: _Vec
    puck_position: _Vec | None
    floor: _Floor | None
    neighbors: list[str]


class _Destination(_Strict):
    name: str = Field(min_length=1)
    sweep_id: str = Field(min_length=1)
    aliases: list[str] = []


class _Export(_Strict):
    format: Literal["storeguide.matterport-sweeps"]
    format_version: int
    exported_at: str
    sdk_version: str | None
    model_id: str = Field(min_length=1)
    coordinate_system: Literal["MATTERPORT_SDK_WORLD"]
    sweep_id_field: Literal["id", "sid", "uuid"]
    start_sweep_id: str | None
    destinations: list[_Destination]
    sweeps: list[_Sweep] = Field(min_length=1)


@dataclass(frozen=True)
class LoadedExport:
    path: Path
    data: ModelNavigationData
    start_sweep_id: str | None
    exported_at: str
    sweep_id_field: str
    total_sweeps: int
    disabled_sweep_ids: tuple[str, ...]
    dropped_connections: int
    """Connections into disabled sweeps, left out of routing."""
    sweeps_without_puck: int
    sweeps_without_floor: int


def _fail(path: Path, message: str) -> ExportError:
    return ExportError(f"{path}: {message}")


def load_export(path: str | Path) -> LoadedExport:
    path = Path(path)
    if not path.is_file():
        raise ExportError(f"Sweep export not found: {path}")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise _fail(path, f"not valid JSON (line {e.lineno}, column {e.colno}).") from None

    if isinstance(raw, dict) and raw.get("format") == EXPORT_FORMAT and raw.get("format_version") not in SUPPORTED_VERSIONS:
        raise _fail(path, f"format_version {raw.get('format_version')!r} isn't supported (expected 1).")
    try:
        doc = _Export.model_validate(raw)
    except ValidationError as e:
        problems = "; ".join(f"{'.'.join(map(str, err['loc'])) or '(top level)'}: {err['msg']}" for err in e.errors()[:8])
        more = f" (+{e.error_count() - 8} more)" if e.error_count() > 8 else ""
        raise _fail(path, f"doesn't match the export format: {problems}{more}") from None

    if doc.model_id.upper().startswith("SAMPLE") or any(s.sweep_id.upper().startswith("SAMPLE") for s in doc.sweeps):
        raise _fail(path, "uses SAMPLE IDs, which are reserved for fake test data. Export from the real space.")

    ids = [s.sweep_id for s in doc.sweeps]
    if len(set(ids)) != len(ids):
        raise _fail(path, "contains duplicate sweep IDs.")
    for s in doc.sweeps:
        recorded = getattr(s, doc.sweep_id_field)
        if recorded is not None and recorded != s.sweep_id:
            raise _fail(path, f"sweep {s.sweep_id}: sweep_id doesn't match its {doc.sweep_id_field!r} field.")

    known = set(ids)
    unknown = sorted({n for s in doc.sweeps for n in s.neighbors if n not in known})
    if unknown:
        shown = ", ".join(unknown[:5]) + (" …" if len(unknown) > 5 else "")
        raise _fail(path, f"{len(unknown)} neighbor ID(s) aren't sweeps in this file: {shown}")

    disabled = {s.sweep_id for s in doc.sweeps if not s.enabled}
    dropped = sum(1 for s in doc.sweeps if s.enabled for n in s.neighbors if n in disabled)
    sweeps = [
        Sweep(
            model_id=doc.model_id,
            sweep_id=s.sweep_id,
            position=Vector3(s.position.x, s.position.y, s.position.z),
            neighbor_ids=tuple(n for n in s.neighbors if n not in disabled),
            puck_position=Vector3(s.puck_position.x, s.puck_position.y, s.puck_position.z) if s.puck_position else None,
            floor=FloorInfo(s.floor.id, s.floor.sequence) if s.floor else None,
        )
        for s in doc.sweeps
        if s.enabled
    ]
    if not sweeps:
        raise _fail(path, "every sweep is disabled; there is nothing to navigate.")

    for d in doc.destinations:
        if d.sweep_id in disabled:
            raise _fail(path, f"destination {d.name!r} points to disabled sweep {d.sweep_id}.")
    if doc.start_sweep_id is not None:
        if doc.start_sweep_id not in known:
            raise _fail(path, f"start_sweep_id {doc.start_sweep_id} isn't a sweep in this file.")
        if doc.start_sweep_id in disabled:
            raise _fail(path, f"start_sweep_id {doc.start_sweep_id} is a disabled sweep.")

    try:
        data = ModelNavigationData.build(
            doc.model_id,
            sweeps,
            [Destination(d.name.strip(), d.sweep_id, tuple(a.strip() for a in d.aliases if a.strip())) for d in doc.destinations],
            is_sample=False,
        )
    except NavigationDataError as e:
        raise _fail(path, str(e)) from None

    return LoadedExport(
        path=path,
        data=data,
        start_sweep_id=doc.start_sweep_id,
        exported_at=doc.exported_at,
        sweep_id_field=doc.sweep_id_field,
        total_sweeps=len(doc.sweeps),
        disabled_sweep_ids=tuple(sorted(disabled)),
        dropped_connections=dropped,
        sweeps_without_puck=sum(1 for s in sweeps if s.puck_position is None),
        sweeps_without_floor=sum(1 for s in sweeps if s.floor is None),
    )
