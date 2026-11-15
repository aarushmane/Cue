"""Replace incomplete scanned objects with AI-generated 3D models (fal.ai TRELLIS image-to-3D).

    py -3.13 complete_objects.py --crops-only          # write each object's photo crop to review first
    py -3.13 complete_objects.py --only obj001,obj007  # generate, align and accept/reject these
    py -3.13 complete_objects.py                       # every object in objects.json
    py -3.13 complete_objects.py --panos <folder>      # pano photos elsewhere (default data/<sid>/panos)

Input: data/<sid>/<bake>/objects.json from clean_mesh.py (scan-patched objects: MatterPak triangles the cleaned
mesh didn't draw). Needs FAL_KEY in .env.local or .env (server-side only), and: pip install trimesh httpx

For each object:
  1. Pick the nearest pano photo that sees it unoccluded and render a square perspective crop around it.
  2. Send the crop to TRELLIS; save the textured GLB.
  3. Align: glTF y-up -> z-up, scale to the scanned height, try 8 headings, refine with ICP against the object's
     scanned surface, stand it on the floor.
  4. Accept if the scanned surface is on average within --max-chamfer of the model and the footprint overlaps the scan's (IoU above
     --min-iou); otherwise the scan patch stays. Results are written back to objects.json.
Then clean_mesh.py is re-run, which swaps accepted objects in for their scan patch. Collisions are unchanged
(they come from the scanner's mesh), so walking stays consistent with what was scanned.
"""
import argparse
import base64
import io
import json
import time
from pathlib import Path

import httpx
import numpy as np
import open3d as o3d
import trimesh
from PIL import Image
from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation

import clean_mesh
from bake_textures import Pano, bilinear, cube_lookup, log, parse_obj
from mp_api import secret

HERE = Path(__file__).resolve().parent
FAL_URL = "https://queue.fal.run/fal-ai/trellis"
CROP = 768


def object_points(MV, MF, lo, hi, floor, n=8000):
    """The whole scanned object: the patch is often only its undrawn part (a freezer's lid), so take every MatterPak
    triangle inside the patch's footprint (+15 cm: its sides often sit just outside) from just above the floor to the patch's top."""
    C = MV[MF].mean(axis=1)
    inside = np.all((C[:, :2] > lo[:2] - 0.15) & (C[:, :2] < hi[:2] + 0.15), axis=1) & (C[:, 2] > floor + 0.03) & (C[:, 2] < hi[2] + 0.03)
    pts = clean_mesh.surface_points(MV, MF[inside], per_m2=20000)
    return pts[np.random.default_rng(1).choice(len(pts), min(n, len(pts)), replace=False)]


def best_view(panos, scan, center, radius):
    """Nearest pano with a clear line of sight to the object (the first hit is the object itself)."""
    best = None
    for p in panos:
        d = center - p.pos
        dist = float(np.linalg.norm(d))
        if dist < 0.6 or dist > 8:
            continue
        ray = o3d.core.Tensor(np.concatenate([p.pos, d / dist])[None].astype(np.float32))
        hit = float(scan.cast_rays(ray)["t_hit"].numpy()[0])
        if hit < dist - radius:
            continue  # something in front of it
        if best is None or dist < best[1]:
            best = (p, dist)
    return best[0] if best else None


def render_crop(p, center, corners, size=CROP):
    """Perspective view from the pano centre towards the object, framing its bbox with a 15% margin."""
    fwd = center - p.pos
    fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, [0, 0, 1.0])
    right /= max(np.linalg.norm(right), 1e-9)
    up = np.cross(right, fwd)
    rel = corners - p.pos
    z = rel @ fwd
    half = float(np.max(np.abs(np.stack([rel @ right, rel @ up], 1)) / np.maximum(z, 0.1)[:, None])) * 1.15
    xs = np.linspace(-half, half, size)
    gx, gy = np.meshgrid(xs, -xs)
    dirs = fwd + gx[..., None] * right + gy[..., None] * up
    dirs = (dirs / np.linalg.norm(dirs, axis=-1, keepdims=True)).reshape(-1, 3)
    face, u, v = cube_lookup(p.to_local.apply(dirs))
    img = p.levels[0]
    res = img.shape[1]
    col = bilinear(img, face, (u * 0.5 + 0.5) * res - 0.5, (v * 0.5 + 0.5) * res - 0.5)
    return Image.fromarray(np.clip(col, 0, 255).astype(np.uint8).reshape(size, size, 3))


def trellis(image: Image.Image, key: str, out: Path):
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=92)
    uri = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    headers = {"Authorization": f"Key {key}"}
    with httpx.Client(timeout=60) as client:
        job = client.post(FAL_URL, headers=headers, json={"image_url": uri}).raise_for_status().json()
        status_url, response_url = job["status_url"], job["response_url"]
        for _ in range(240):
            status = client.get(status_url, headers=headers).raise_for_status().json().get("status")
            if status == "COMPLETED":
                break
            if status not in ("IN_QUEUE", "IN_PROGRESS"):
                raise RuntimeError(f"TRELLIS job {status}")
            time.sleep(2.5)
        else:
            raise RuntimeError("TRELLIS timed out")
        result = client.get(response_url, headers=headers).raise_for_status().json()
        url = next((v["url"] for v in result.values() if isinstance(v, dict) and str(v.get("url", "")).endswith(".glb")), None)
        if not url:
            raise RuntimeError(f"No GLB in TRELLIS response: {list(result)}")
        out.write_bytes(client.get(url).raise_for_status().content)


def load_glb(path: Path):
    """GLB -> (vertices z-up, faces, uvs, texture image)."""
    mesh = trimesh.load(path, force="mesh")
    V = np.asarray(mesh.vertices, np.float64) @ np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]])  # y-up -> z-up
    uv = np.asarray(getattr(mesh.visual, "uv", None) if hasattr(mesh.visual, "uv") else np.zeros((len(V), 2)))
    mat = getattr(mesh.visual, "material", None)
    tex = getattr(mat, "baseColorTexture", None) or getattr(mat, "image", None)
    return V, np.asarray(mesh.faces), uv, tex


def chamfer(a, b):
    return 0.5 * (cKDTree(b).query(a)[0].mean() + cKDTree(a).query(b)[0].mean())


def footprint_iou(a, b, cell=0.05):
    ka = set(map(tuple, np.floor(a[:, :2] / cell).astype(int)))
    kb = set(map(tuple, np.floor(b[:, :2] / cell).astype(int)))
    return len(ka & kb) / max(1, len(ka | kb))


def align(V, F, target, floor):
    """Try 4 headings; for each, scale every axis to the scanned object's box (capped at 1.5x stretch between axes so
    it keeps its look) and keep the lowest chamfer; ICP-refine; stand it on the floor."""
    tlo, thi = target.min(0), target.max(0)
    tlo[2] = floor
    size, center = thi - tlo, (thi + tlo) / 2
    best = None
    for k in range(4):
        R = Rotation.from_euler("z", k * 90, degrees=True).as_matrix()
        W = V @ R.T
        s = size / np.maximum(np.ptp(W, 0), 1e-6)
        s = np.clip(s, s.mean() / 1.5, s.mean() * 1.5)
        W = (W - (W.min(0) + W.max(0)) / 2) * s + center
        pts = trimesh.Trimesh(W, F, process=False).sample(5000)
        c = chamfer(pts, target)
        if best is None or c < best[0]:
            best = (c, W, pts)
    _, W, src = best
    pcs, pct = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(src)), o3d.geometry.PointCloud(o3d.utility.Vector3dVector(target))
    reg = o3d.pipelines.registration.registration_icp(pcs, pct, 0.08, np.eye(4), o3d.pipelines.registration.TransformationEstimationPointToPoint())
    T = reg.transformation
    out = W @ T[:3, :3].T + T[:3, 3]
    out[:, 2] += floor - out[:, 2].min()  # never sink below or float above the floor
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sid", nargs="?", default="UzwrJ9TbQuG")
    ap.add_argument("--panos", type=Path, help="pano folder with panos.json (default data/<sid>/panos)")
    ap.add_argument("--only", help="comma-separated object ids")
    ap.add_argument("--crops-only", action="store_true")
    ap.add_argument("--regenerate", action="store_true", help="call TRELLIS again even if model.glb exists")
    ap.add_argument("--max-chamfer", type=float, default=0.08)
    ap.add_argument("--min-iou", type=float, default=0.5)
    args = ap.parse_args()

    root = HERE / "data" / args.sid
    meta = json.loads((root / "meta.json").read_text(encoding="utf-8"))
    bake_dir = (root / meta["baked"]["obj"]).parent
    objects_path = bake_dir / "objects.json"
    data = json.loads(objects_path.read_text(encoding="utf-8"))
    floor = data["floor_z"]
    wanted = set(args.only.split(",")) if args.only else None
    objects = [o for o in data["objects"] if not wanted or o["id"] in wanted]
    if not objects:
        raise SystemExit("No matching objects. Run clean_mesh.py first, or check --only.")
    key = None if args.crops_only else secret("FAL_KEY")

    pano_dir = args.panos or root / "panos"
    plist = json.loads((pano_dir / "panos.json").read_text(encoding="utf-8"))["panos"]
    panos = [Pano(pano_dir / p["id"], p) for p in plist]
    MV, _, MF, *_ = parse_obj(root / data["matterpak"])
    scan = o3d.t.geometry.RaycastingScene()
    scan.add_triangles(o3d.core.Tensor(MV.astype(np.float32)), o3d.core.Tensor(MF.astype(np.uint32)))

    loaded = None
    for o in objects:
        lo, hi = np.array(o["bbox"][0]), np.array(o["bbox"][1])
        center = (lo + hi) / 2
        corners = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
        p = best_view(panos, scan, center, float(np.linalg.norm(hi - lo)) / 2)
        if p is None:
            o["ai"] = {"status": "rejected", "reason": "no clear photo"}
            log(f"{o['id']}: no clear photo")
            continue
        if loaded is not p:
            if loaded:
                loaded.unload()
            p.load()
            loaded = p
        work = bake_dir / "objects" / o["id"]
        work.mkdir(parents=True, exist_ok=True)
        render_crop(p, center, corners).save(work / "view.jpg", quality=92)
        if args.crops_only:
            log(f"{o['id']}: crop -> {work / 'view.jpg'}")
            continue
        try:
            if args.regenerate or not (work / "model.glb").exists():
                trellis(Image.open(work / "view.jpg"), key, work / "model.glb")
            V, F, uv, tex = load_glb(work / "model.glb")
            target = object_points(MV, MF, lo, hi, floor)
            Va = align(V, F, target, floor)
            sample = trimesh.Trimesh(Va, F, process=False).sample(5000)
            # The scan has holes (that's why this object was patched), so judge how well the model covers what was
            # scanned (scan -> model); model -> scan is reported but expected to be large where the scan is missing.
            c = float(cKDTree(sample).query(target)[0].mean())
            back = float(cKDTree(target).query(sample)[0].mean())
            iou = float(footprint_iou(sample, target))
            ok = c < args.max_chamfer and iou > args.min_iou and tex is not None and len(uv) == len(Va)
            if ok:
                tex.convert("RGB").save(work / "texture.jpg", quality=90)
                with open(work / "aligned.obj", "w", encoding="utf-8") as fh:
                    fh.write("".join(f"v {x:.5f} {y:.5f} {z:.5f}\n" for x, y, z in Va))
                    fh.write("".join(f"vt {u:.6f} {v:.6f}\n" for u, v in uv))
                    fh.write("".join(f"f {a}/{a} {b}/{b} {c_}/{c_}\n" for a, b, c_ in F + 1))
            o["ai"] = {"status": "accepted" if ok else "rejected", "scan_to_model_m": round(c, 3), "model_to_scan_m": round(back, 3), "iou": round(iou, 2),
                       "pano": plist[panos.index(p)]["id"], "bbox": o["bbox"]}
            log(f"{o['id']}: {'accepted' if ok else 'rejected'} (scan->model {c * 100:.1f} cm, model->scan {back * 100:.1f} cm, footprint IoU {iou:.2f})")
        except Exception as error:  # one failed object must not stop the rest
            o["ai"] = {"status": "rejected", "reason": str(error)[:200]}
            log(f"{o['id']}: failed: {error}")
        objects_path.write_text(json.dumps(data), encoding="utf-8")
    if loaded:
        loaded.unload()
    objects_path.write_text(json.dumps(data), encoding="utf-8")
    if not args.crops_only:
        log("re-running clean_mesh.py to swap accepted objects in")
        clean_mesh.main([args.sid])


if __name__ == "__main__":
    main()
