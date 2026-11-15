"""Download one Matterport model's textured mesh (from its MatterPak) plus pano positions, for the viewer.

    py -3.13 get_mesh.py                 # J&B Food Market (UzwrJ9TbQuG)
    py -3.13 get_mesh.py Yf9tAq5Svwr     # any sid from models_index.csv
    py -3.13 get_mesh.py UzwrJ9TbQuG --cloud   # also keep the coloured point cloud (cloud.xyz, big) and pack it for the viewer

Writes data/<sid>/: the OBJ + MTL + textures, panos.json, meta.json.
"""
import argparse
import json
import re
import zipfile
from pathlib import Path

from mp_api import HttpFile, MatterportError, graph

HERE = Path(__file__).resolve().parent

Q_BASICS = """query Basics($id: ID!) { model(id: $id) {
  id name
  address { address locality administrativeArea postalCode }
  geolocation { lat long }
  generatedDescription { summary }
  panoLocations { id label position { x y z } }
} }"""

Q_MATTERPAK = """query MatterPak($id: ID!) { model(id: $id) {
  bundle(id: "mp:matterpak") { availability assets { ... on Resource { format status filename url } } }
} }"""


def obj_bounds(path):
    """Min/max of the OBJ's vertex positions (metres, Z up)."""
    lo, hi = [float("inf")] * 3, [float("-inf")] * 3
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if line.startswith("v "):
                xyz = [float(v) for v in line.split()[1:4]]
                lo = [min(a, b) for a, b in zip(lo, xyz)]
                hi = [max(a, b) for a, b in zip(hi, xyz)]
    return lo, hi


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sid", nargs="?", default="UzwrJ9TbQuG", help="Matterport model id")
    ap.add_argument("--cloud", action="store_true", help="also extract cloud.xyz (point cloud)")
    args = ap.parse_args()
    sid = args.sid
    out = HERE / "data" / sid
    out.mkdir(parents=True, exist_ok=True)

    m = graph(Q_BASICS, id=sid)["model"]
    print(f"{m.get('name')}  ({sid})  {(m.get('address') or {}).get('address', '')}")
    panos = [{"id": p["id"], "label": p.get("label"), "position": p["position"]} for p in m.get("panoLocations") or []]
    panos.sort(key=lambda p: (not str(p["label"]).isdigit(), int(p["label"]) if str(p["label"]).isdigit() else 0, str(p["label"])))
    (out / "panos.json").write_text(json.dumps(panos, indent=2), encoding="utf-8")
    print(f"{len(panos)} panos -> {out / 'panos.json'}")

    bundle = graph(Q_MATTERPAK, id=sid)["model"].get("bundle") or {}
    pak = next((a for a in bundle.get("assets") or [] if a.get("url")), None)
    if not pak:
        raise SystemExit(f"MatterPak for {sid} is {bundle.get('availability', 'unavailable')}: no download link yet. "
                         f"Ask in the CoStar track Discord channel, or try another model.")

    zf = zipfile.ZipFile(HttpFile(pak["url"]))
    print(f"MatterPak: {zf.fp.size / 1e6:.0f} MB zipped. Contents:")
    for i in sorted(zf.infolist(), key=lambda i: -i.compress_size):
        print(f"  {i.filename:<50} {i.file_size / 1e6:8.1f} MB")

    wanted = []
    for name in zf.namelist():
        low = name.lower()
        if low.endswith((".obj", ".mtl")):
            wanted.append(name)
        elif low.endswith((".jpg", ".jpeg", ".png")) and "plan" not in low:
            wanted.append(name)  # mesh textures (floor-plan renders skipped)
        elif args.cloud and low.endswith("cloud.xyz"):
            wanted.append(name)
    for name in wanted:
        zf.extract(name, out)
    print(f"extracted {len(wanted)} files -> {out}")

    objs = sorted(out.rglob("*.obj"), key=lambda p: -p.stat().st_size)
    if not objs:
        raise SystemExit("No .obj in this MatterPak.")
    obj = objs[0]
    mtl = None
    with open(obj, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            mm = re.match(r"mtllib\s+(.+)", line)
            if mm:
                mtl = mm.group(1).strip()
                break
    lo, hi = obj_bounds(obj)
    meta = {
        "sid": sid,
        "name": m.get("name"),
        "address": (m.get("address") or {}).get("address"),
        "geolocation": m.get("geolocation"),
        "summary": (m.get("generatedDescription") or {}).get("summary"),
        "obj": obj.relative_to(out).as_posix(),
        "mtl": (obj.parent / mtl).relative_to(out).as_posix() if mtl else None,
        "bounds": {"min": lo, "max": hi},
        "up": "z",
    }
    old_meta = out / "meta.json"
    if old_meta.exists():  # keep the entries get_cloud.py and bake_textures.py added
        old = json.loads(old_meta.read_text(encoding="utf-8"))
        for key, path in (("cloud", "cloud.bin"), ("baked", "baked/mesh.obj")):
            if old.get(key) and (out / path).exists():
                meta[key] = old[key]
    old_meta.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"mesh {meta['obj']}  bounds {[round(v, 1) for v in lo]} .. {[round(v, 1) for v in hi]} m")
    if args.cloud:
        import get_cloud
        get_cloud.build(sid)
    print(f"\nView it:  py -3.13 -m http.server 8000   then open  http://localhost:8000/viewer/?m={sid}")


if __name__ == "__main__":
    try:
        main()
    except MatterportError as e:
        raise SystemExit(str(e))
