"""Pack a model's coloured point cloud (cloud.xyz from the MatterPak) into cloud.bin for the viewer.

    py -3.13 get_cloud.py                # J&B Food Market (UzwrJ9TbQuG)
    py -3.13 get_cloud.py Yf9tAq5Svwr    # any sid already fetched with get_mesh.py

Downloads data/<sid>/cloud.xyz if it is missing (about 50 MB zipped, 200 MB unzipped), then writes
data/<sid>/cloud.bin and adds a "cloud" entry to meta.json.

cloud.bin layout: N x 3 uint16 positions, then N x 3 uint8 sRGB colours.
Position = min + q * scale (metres, Z up); the 16-bit grid is about 0.3 mm over a 20 m store.
"""
import argparse
import json
import zipfile
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent


def download_xyz(sid, out):
    from get_mesh import Q_MATTERPAK
    from mp_api import HttpFile, graph

    bundle = graph(Q_MATTERPAK, id=sid)["model"].get("bundle") or {}
    pak = next((a for a in bundle.get("assets") or [] if a.get("url")), None)
    if not pak:
        raise SystemExit(f"MatterPak for {sid} is {bundle.get('availability', 'unavailable')}.")
    zf = zipfile.ZipFile(HttpFile(pak["url"]))
    name = next((n for n in zf.namelist() if n.lower().endswith("cloud.xyz")), None)
    if not name:
        raise SystemExit("This MatterPak has no cloud.xyz.")
    print(f"downloading {name} ({zf.getinfo(name).compress_size / 1e6:.0f} MB zipped)...")
    zf.extract(name, out)
    return out / name


def build(sid):
    out = HERE / "data" / sid
    meta_path = out / "meta.json"
    if not meta_path.exists():
        raise SystemExit(f"No {meta_path}. Run: py -3.13 get_mesh.py {sid}")
    xyz_path = next(iter(out.rglob("cloud.xyz")), None) or download_xyz(sid, out)

    print(f"reading {xyz_path.name}...")
    pts = np.loadtxt(xyz_path, dtype=np.float32, usecols=range(6))
    xyz, rgb = pts[:, :3], np.clip(pts[:, 3:6], 0, 255).astype(np.uint8)
    lo, hi = xyz.min(0), xyz.max(0)
    scale = np.maximum(hi - lo, 1e-6) / 65535.0
    q = np.round((xyz - lo) / scale).astype(np.uint16)

    with open(out / "cloud.bin", "wb") as fh:
        fh.write(q.tobytes())
        fh.write(rgb.tobytes())

    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["cloud"] = {"file": "cloud.bin", "count": int(len(q)),
                     "min": [float(v) for v in lo], "scale": [float(v) for v in scale]}
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    size = (out / "cloud.bin").stat().st_size / 1e6
    print(f"{len(q):,} points -> {out / 'cloud.bin'} ({size:.0f} MB)")
    print(f"\nView it:  http://localhost:8000/viewer/?m={sid}  then press M")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sid", nargs="?", default="UzwrJ9TbQuG", help="Matterport model id")
    build(ap.parse_args().sid)
