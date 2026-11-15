"""Download each pano's 4k skybox (6 cube faces) plus its position and rotation.

    py -3.13 fetch_panos.py                # J&B Food Market (UzwrJ9TbQuG)
    py -3.13 fetch_panos.py <sid> --res 2k

Writes data/<sid>/panos/<pano id>/skybox0..5.jpg and data/<sid>/panos/panos.json.
Positions are metres in the mesh frame (Z up); rotation is a quaternion {x, y, z, w}.
"""
import argparse
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from mp_api import MatterportError, graph, session

HERE = Path(__file__).resolve().parent

Q = """query Panos($id: ID!, $res: String!) { model(id: $id) {
  panoLocations { id label position { x y z } rotation { x y z w }
    skybox(resolution: $res) { status children } }
} }"""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sid", nargs="?", default="UzwrJ9TbQuG")
    ap.add_argument("--res", default="4k", help="skybox resolution: 4k, 2k, high, low")
    args = ap.parse_args()
    out = HERE / "data" / args.sid / "panos"
    out.mkdir(parents=True, exist_ok=True)

    locs = graph(Q, id=args.sid, res=args.res)["model"]["panoLocations"]
    jobs, panos = [], []
    for p in locs:
        sky = p.get("skybox") or {}
        if sky.get("status") != "available" or len(sky.get("children") or []) != 6:
            print(f"skip {p['id']}: skybox {sky.get('status')}")
            continue
        d = out / p["id"]
        d.mkdir(exist_ok=True)
        for i, url in enumerate(sky["children"]):
            jobs.append((url, d / f"skybox{i}.jpg"))
        panos.append({"id": p["id"], "label": p.get("label"), "position": p["position"], "rotation": p["rotation"]})

    def get(job):
        url, path = job
        if path.exists() and path.stat().st_size > 0:
            return 0
        r = session().get(url, timeout=120)  # signed CDN link; the session's auth header is ignored
        r.raise_for_status()
        path.write_bytes(r.content)
        return len(r.content)

    with ThreadPoolExecutor(8) as pool:
        total = sum(pool.map(get, jobs))
    (out / "panos.json").write_text(json.dumps({"resolution": args.res, "panos": panos}, indent=2), encoding="utf-8")
    print(f"{len(panos)} panos, {len(jobs)} faces ({total / 1e6:.0f} MB new) -> {out}")


if __name__ == "__main__":
    try:
        main()
    except MatterportError as e:
        raise SystemExit(str(e))
