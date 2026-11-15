# Matterport navigation agent (standalone)

A LangChain Deep Agent (`deepagents.create_deep_agent`) that guides people between Matterport
sweeps. It is **not connected** to the frontend, the FastAPI backend, or a live Matterport viewer.
All routing and arrow geometry is deterministic Python; the language model only decides which
tool to call and words the answer.

## Setup

All commands below run from **this folder** (`matterport_agent/`, the one with `.env.example`).
From the repo root, `cd matterport_agent` first; running elsewhere fails with
`No module named 'matterport_agent'`.

```bash
cd matterport_agent
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
cp .env.example .env
```

### Adding your API key

Open `matterport_agent/.env` in your editor and put the key after the `=` on the
`ANTHROPIC_API_KEY=` line (no quotes, no spaces). Get a key from the Claude Console
(platform.claude.com → API keys). Don't paste it into chat, code, or any other file.
`.env` is git-ignored, so it won't be committed; `git status` should never list it.

The demo always loads `matterport_agent/.env` (a fixed path, wherever you run from) and
prints only the file path, never values. A variable already exported in your shell wins over `.env`.

| Variable | Purpose |
|---|---|
| `MATTERPORT_AGENT_MODEL` | `provider:model` for `create_deep_agent`. Default `anthropic:claude-opus-5-5`. |
| `ANTHROPIC_API_KEY` | Needed for the `anthropic:` provider. |
| `MATTERPORT_ARROW_VERTICAL_OFFSET_M` | Demo only: arrow lift above the floor, meters (default `0.05`). |

### Check the model before a paid run

```bash
.venv/bin/python -m matterport_agent.demo --check-model
```

This asks the provider's Models API whether your key can see the configured model. Models
API calls aren't billed. On success it prints `OK: provider recognizes claude-opus-5-5 ...`.
A bad key, missing model access, or an unknown model each give a one-line explanation.

## Run

```bash
The demo never picks data for you: pass `--data FILE` (a real export, see below), set
`MATTERPORT_SWEEPS_FILE` in `.env`, or pass `--sample` for the made-up model. With none of
these it stops with an error.

```bash
# Free: runs the same tools directly, no model call. The argument is a destination name.
.venv/bin/python -m matterport_agent.demo --sample "Mezzanine" --offline --start SAMPLE-sweep-aisle-1-back

# Uses the model (paid).
.venv/bin/python -m matterport_agent.demo --sample "How do I get upstairs?" --start SAMPLE-sweep-entrance

# Arrow options
.venv/bin/python -m matterport_agent.demo --sample "Checkout" --offline --start SAMPLE-sweep-aisle-1-back \
    --arrow-offset 0.1 --floor-height SAMPLE-floor-0=0.0
```

Both modes print the same report: each tool call with its input and result, the route, and the
next arrow (anchor, target, direction, floor change). Agent mode also checks the agent's route
against a fresh deterministic one and prints the agent's answer text. Reasoning blocks are never
printed. Add `--json` for machine-readable output, `--full-results` to see long results in full.

## Testing with your real store

### 1. Allow localhost on your Matterport SDK key (once)

In Matterport: **Settings → Developer Tools → SDK Key Management**. Make sure your SDK key's
allowed domains include `localhost:8787`. You also need to be able to open the space in the
browser you'll use (sign in to Matterport there if the space is private).

### 2. Export the sweeps

```bash
cd matterport_agent
.venv/bin/python -m http.server 8787 --bind 127.0.0.1 --directory exporter
```

Open <http://localhost:8787> and:

1. Enter the **model ID** (the `m=` value in the space's share link) and your **SDK key**, then
   click **Connect**. The key is held in the page's memory only, and is never saved or exported.
2. Wait for "Connected. N sweeps loaded".
3. Walk to where a test should begin and click **Use as starting point**.
4. Walk to the checkout, type `Checkout` (aliases optional, such as `registers`), and click
   **Label current sweep**. Repeat for any other destinations.
5. Click **Download JSON** and move the file to `matterport_agent/data/store-sweeps.json`.
6. Press Ctrl+C in the terminal to stop the server.

`data/*.json` is git-ignored. The file contains the model ID, sweep IDs, SDK coordinates, puck
positions, floor info, neighbor connections, your start, and your labels. It never contains a key.

### 3. Check the file (free)

```bash
.venv/bin/python -m matterport_agent.demo --data data/store-sweeps.json --list-sweeps
```

This validates the export and lists destinations and sweeps. Problems stop with a clear message,
for example a SAMPLE ID, a neighbor that isn't in the file, or bad coordinates. Nothing is repaired.
Disabled sweeps are reported and left out of routing.

### 4. Test without AI (free)

```bash
.venv/bin/python -m matterport_agent.demo --data data/store-sweeps.json "Checkout" --offline
```

Add `--start SWEEP_ID` to begin somewhere other than the exported start. If the arrow says
**needs a floor height** (no puck position for that sweep), pass `--floor-height FLOOR_ID=Y`.

### 5. Test with the real agent (paid)

```bash
.venv/bin/python -m matterport_agent.demo --check-model                               # free; expect "OK"
.venv/bin/python -m matterport_agent.demo --data data/store-sweeps.json "Take me to checkout"
```

## Test (no model calls, no key needed)

```bash
.venv/bin/python -m pytest
node --test exporter/export-core.test.mjs
```

## Files

| Path | What |
|---|---|
| `matterport_agent/models.py` | Validated, immutable sweep graph + destinations for one model (copied from `navigation_service/app/navigation/models.py`) |
| `matterport_agent/routing.py` | Dijkstra over declared one-way neighbor links (copied from `navigation_service/app/navigation/service.py`) |
| `matterport_agent/arrows.py` | `create_arrow_instructions` geometry and the `ArrowInstruction` schema |
| `matterport_agent/sample_data.py` | **Made-up SAMPLE data. Not real Matterport IDs.** |
| `matterport_agent/context.py` | `NavigationSession`: per-invocation model data + arrow settings |
| `matterport_agent/tools.py` | The three LangChain tools |
| `matterport_agent/agent.py` | `build_navigation_agent()` and the system prompt |
| `matterport_agent/demo.py` | Command-line demo |
| `matterport_agent/real_data.py` | Strict loader for real sweep exports |
| `matterport_agent/report.py` | Terminal report: tool calls, route, next arrow |
| `exporter/index.html` | Local page that connects to your space with the Matterport SDK and downloads the sweep JSON |
| `exporter/export-core.js` | Export logic (no browser needed; tested with `node --test`) |
| `data/` | Where your export goes (`*.json` is git-ignored) |

## Using it from code

```python
from matterport_agent.agent import build_navigation_agent
from matterport_agent.arrows import ArrowConfig
from matterport_agent.context import NavigationSession

agent = build_navigation_agent()                       # stateless, safe to reuse
session = NavigationSession(model_data=my_model_data,  # one Matterport model per session
                            arrow_config=ArrowConfig(vertical_offset_m=0.05))
result = agent.invoke({"messages": [{"role": "user", "content": "I'm at sweep X. Take me to checkout."}]},
                      context=session)
```

Tools read `runtime.context` (LangChain `ToolRuntime`), which the model can't see or set, so one
session can never reach another model's sweeps.

## Tools

- `resolve_destination(name)` → `MATCH` + `sweep_id`, or `UNKNOWN_DESTINATION` + available names.
- `plan_navigation(start_id, destination_id)` → `ROUTE` | `ARRIVED` | `UNREACHABLE` | `UNKNOWN_START` | `UNKNOWN_DESTINATION`.
- `create_arrow_instructions(from_sweep_id, to_sweep_id)` → an `ArrowInstruction`, or an error with
  `UNKNOWN_SWEEP` / `NOT_CONNECTED` (the target must be a declared neighbor of the source).

### `ArrowInstruction`

| Field | Meaning |
|---|---|
| `model_id` | Matterport model the sweeps belong to |
| `coordinate_system` | Always `MATTERPORT_SDK_WORLD` (meters, Y up) |
| `status` | `STEP`, `FLOOR_TRANSITION`, or `ARRIVED` |
| `source_sweep_id`, `target_sweep_id` | The step |
| `anchor` | Arrow base: `{position, source, floor_id}` |
| `source_sweep_position` | Source sweep's SDK (camera) position, for reference only |
| `target_position` | Target sweep's SDK position |
| `target_floor` | Target's floor point, same rules as `anchor` |
| `direction` | Unit `{x, z}` on the horizontal plane, or `null` |
| `direction_status` | `OK`, `ZERO_LENGTH` (target directly above/below), `NOT_APPLICABLE` (arrived) |
| `horizontal_distance_m` | X/Z distance |
| `floor_transition`, `floor_sequence_delta` | `SAME_FLOOR` / `FLOOR_CHANGE` / `UNKNOWN`; +1 up, -1 down |
| `vertical_offset_m` | Offset that was applied |
| `needs_floor_height` | `true` if `anchor` or `target_floor` couldn't be placed |

Placement (`anchor.source`): `PUCK` (puck position + offset) → `SUPPLIED_FLOOR_HEIGHT` (sweep X/Z,
configured floor Y + offset) → `NEEDS_FLOOR_HEIGHT` (`position: null`). Camera height is never
treated as floor height. Floor heights are set in `ArrowConfig.floor_heights_m`, keyed by floor id.

## Known limits

- The model code is duplicated from `navigation_service/`; merge into one shared package when the two are wired together.
- No real Matterport data yet. Real sweeps would be exported from the SDK (`sweep.data`) and loaded into `ModelNavigationData`.
- No rendering, camera movement, or SDK calls; that comes with the viewer integration.
