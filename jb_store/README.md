# jb_store: walk a Matterport store in 3D

Run every command below from inside `jb_store/`. Not in git: `data/` (the meshes and photos, about 1 GB; rebuild it with the scripts below or ask Mann for a zip) and `models_index.csv` (CoStar hackathon data, hackathon use only).

Downloads a model's textured mesh from the Matterport Model API (its MatterPak) and opens it in a first-person three.js viewer with WASD + mouse/trackpad look. This is the base for the "find an item in the store" app.

Based on the HackPrinceton 2026 Matterport quickstart: https://beta-app.matterport.com/2026-princeton-hackathon/quickstart

## Setup

1. Get the keys with `/costar-keys` in the track Discord.
2. Copy `.env.example` to `.env` and fill in `MATTERPORT_API_KEY` and `MATTERPORT_API_TOKEN`. `.env` is git-ignored, so never commit it.
3. Install the one dependency (Python 3.13 here, since the default `python` on this machine is 3.6):

   ```
   py -3.13 -m pip install -r requirements.txt
   ```

## Get a mesh

```
py -3.13 get_mesh.py                # J&B Food Market, Houston (UzwrJ9TbQuG)
py -3.13 get_mesh.py Yf9tAq5Svwr    # Sunny's food store, Houston
```

This writes `data/<sid>/` with the OBJ, MTL and textures from the MatterPak, `panos.json` (the scan positions), and `meta.json`. It reads only the members it needs out of the remote zip, using HTTP range requests. Add `--cloud` to also keep the coloured point cloud (`cloud.xyz`, large) and pack it for the viewer (`cloud.bin`). For a model you already fetched, `py -3.13 get_cloud.py <sid>` does just the point cloud.

Any `sid` in `models_index.csv` works (14,945 models). If a model's MatterPak isn't ready, the script says so.

## Photo textures (sharper)

```
py -3.13 fetch_panos.py             # 4k skybox photos for every pano, about 50 MB for J&B
```

Then bake new textures from them (needs `pip install pillow open3d xatlas scipy`; about 10 minutes for J&B):

```
py -3.13 bake_textures.py           # writes data/<sid>/baked/, the viewer then uses it
py -3.13 bake_textures.py --texels 150   # finer, for a GPU with memory to spare (default 100M texels, ~0.5 GB)
```

The bake unwraps the mesh into fresh 4096² atlases, giving each triangle texels as fine as its sharpest photo (down to a floor the texel budget sets). It checks with ray casting which panos really see each texel, samples the 4k photos with filtering matched to the texel size, and blends the panos, favouring the sharpest view. Spots no pano saw keep the MatterPak texture.

Holes in the mesh (glass, shiny or dark surfaces the scanner missed) are not papered over with photos: that looked made-up. Fill them with real geometry instead (next section). Without a bake, the viewer projects the photos onto the mesh live instead (2k faces, about 0.7 GB of GPU memory for 5 panos; `&pano=4k` for full size at about 4× that).

## Better geometry: rebuild from the point cloud + monocular depth

```
py -3.13 get_mesh.py UzwrJ9TbQuG --cloud      # if you don't have cloud.xyz yet
py -3.13 -m pip install torch --index-url https://download.pytorch.org/whl/cpu
py -3.13 -m pip install transformers
py -3.13 rebuild_mesh.py                       # ~15 min on a laptop CPU; --no-depth skips the depth model
py -3.13 bake_textures.py --mesh rebuilt       # bakes onto it -> data/<sid>/baked_rebuilt/, the viewer then uses it
```

`rebuild_mesh.py` meshes the scanner's point cloud (millions of points, much denser than the MatterPak mesh) with screened Poisson reconstruction. Where the scanner saw nothing, or saw only something far behind (glass coolers, shiny or dark surfaces), it runs Depth Anything V2 (metric indoor) on each pano cube face. It lines that depth up with the scan per face (scale + shift; the model is about 2–3× off on 90° faces), then adds points at the estimated depth. Any surface Poisson invents more than 3 cm from a real point is cut away again, so remaining holes stay holes. Tuning: `--poisson 10` (faster, coarser), `--faces` (triangle budget, default 800k), `--trim`.

## Walk around

```
py -3.13 -m http.server 8000
```

Then open http://localhost:8000/viewer/?m=UzwrJ9TbQuG.

| Input | Action |
|---|---|
| Click, then move the mouse or trackpad | look around (or click and drag, if the browser refuses pointer lock) |
| W A S D | move |
| Space / C | up / down |
| Shift | move faster |
| F | toggle walk mode (fixed eye height) and fly mode |
| P | show or hide pano markers (blue dots = scan positions) |
| T | photo textures (baked or live) / original MatterPak textures |
| M | switch between mesh, point cloud, and both (the point cloud loads the first time) |
| [ / ] | smaller / bigger points |
| 1–9 | jump to a pano |
| Esc | free the cursor |

The mesh is Z-up in metres. The viewer converts it to three.js Y-up, but the readout at the bottom shows the position in Matterport's frame, the same frame as the panos, rooms and walls from the API, so detected items can be placed in it later.

`data/_test` is a synthetic room for checking the viewer without keys: http://localhost:8000/viewer/?m=_test.

## Files

- `mp_api.py`: key loading, the `graph()` GraphQL helper, and `HttpFile` (range-request zip reading)
- `get_mesh.py`: MatterPak → `data/<sid>/`
- `fetch_panos.py`: 4k pano skybox photos + pano positions and rotations → `data/<sid>/panos/`
- `bake_textures.py`: bakes textures from the pano photos → `data/<sid>/baked/` (or `baked_rebuilt/` with `--mesh rebuilt`)
- `rebuild_mesh.py`: point cloud + monocular depth → `data/<sid>/rebuilt/mesh.obj`
- `viewer/panotex.js`: paints the mesh from the pano photos (skybox face layout is documented at its top)
- `get_cloud.py`: `cloud.xyz` → `cloud.bin` (16-bit positions + RGB, 9 bytes a point) for the viewer
- `viewer/`: three.js first-person viewer
- `models_index.csv`: every model the hackathon key can see, with lat/lon, address, CoStar property id and pano count

## Next steps for the item finder

- Panoramas: `panoLocations { skybox(resolution: "2k") { children } }` (quickstart section 4) gives six cube faces per scan, so you can run item detection on them.
- Use the pano `position` plus a direction per detected pixel, raycast against this mesh, and you get an item's 3D position.
- Rooms and walls (quickstart section 5) can help with pathfinding.
