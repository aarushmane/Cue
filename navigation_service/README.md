# StoreGuide navigation service (FastAPI)

Deterministic sweep-to-sweep navigation for a Matterport model, plus LangChain tools for the
navigation agent. It runs alongside the Next.js app; it does not replace `app/api/`.

```bash
cd navigation_service
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest              # tests
.venv/bin/uvicorn app.main:app --reload --port 8000
```

| Path | What |
|---|---|
| `app/navigation/models.py` | Immutable, validated sweep graph + destinations for one model |
| `app/navigation/service.py` | Dijkstra routing, arrow directions, destination lookup (pure functions) |
| `app/navigation/sample_data.py` | **Made-up sample data for local tests. Not real Matterport IDs.** |
| `app/navigation/repository.py` | Read-only lookup by Matterport model ID |
| `app/agent/tools.py` | `resolve_destination(name)` and `plan_navigation(start_id, destination_id)` |
| `app/main.py` | HTTP routes |

## API

- `GET /health`
- `GET /models/{model_id}/destinations`
- `POST /models/{model_id}/navigation/resolve` `{ "name": "Help desk" }`
- `POST /models/{model_id}/navigation/plan` `{ "start_sweep_id": "...", "destination_sweep_id": "..." }`

Plan `status`: `ROUTE`, `ARRIVED`, `UNREACHABLE`, `UNKNOWN_START`, `UNKNOWN_DESTINATION`.
Each step has `direction` (unit vector on SDK X/Z, Y is up) or `null` with
`direction_status: "ZERO_LENGTH"`, and `floor_transition`: `SAME_FLOOR`, `FLOOR_CHANGE`, or `UNKNOWN`.

## Rules

- Edges are the sweep's declared `neighbor_ids` only, and are one-way (A→B doesn't imply B→A).
- Bad data (unknown neighbor, sweep from another model, non-finite coordinate) fails at load time.
- No per-user state on the server. The client sends its current sweep with every plan request.
