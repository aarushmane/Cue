"""Rebuild a model's mesh from its coloured point cloud, filling scanner holes with monocular depth.

    py -3.13 rebuild_mesh.py                     # J&B Food Market (UzwrJ9TbQuG)
    py -3.13 rebuild_mesh.py <sid> --no-depth    # point cloud only, no depth model
    py -3.13 rebuild_mesh.py <sid> --poisson 10  # coarser and faster (default 11, about 1 cm cells here)

Needs the point cloud (get_mesh.py --cloud) and the pano photos (fetch_panos.py), plus:
    pip install open3d scipy pillow
    pip install torch --index-url https://download.pytorch.org/whl/cpu ; pip install transformers   (for the depth step)

Steps:
  1. Load cloud.xyz (millions of scanner points), thin it to a voxel grid, estimate normals and point each
     one at the nearest pano that can see it.
  2. Holes: for every pano cube face, run a monocular depth model (Depth Anything V2, metric indoor) on the
     photo, line its depth up with the MatterPak mesh where the scanner did see the surface (scale + shift per
     face), and keep only the pixels where the scanner saw nothing or saw something far behind (glass, shiny
     or dark surfaces). Those pixels become extra points, at the depth the model estimated. No photo is ever
     shown in place of geometry: the photos only colour surfaces that exist in the mesh.
  3. Screened Poisson surface reconstruction over both point sets, then cut away every part of the surface
     that is not close to a real point (Poisson closes holes with smooth guesses; those are removed again),
     drop tiny fragments and decimate.
Writes data/<sid>/rebuilt/mesh.obj (vertex colours from the cloud) and adds "rebuilt" to meta.json.
Then: py -3.13 bake_textures.py <sid> --mesh rebuilt
"""
import argparse
import json
import time
from pathlib import Path

import numpy as np
import open3d as o3d
from PIL import Image
from scipy import ndimage
from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation

from bake_textures import parse_obj

HERE = Path(__file__).resolve().parent
DEPTH_MODEL = "depth-anything/Depth-Anything-V2-Metric-Indoor-Base-hf"


def log(msg, t0=[time.time()]):
    print(f"[{time.time() - t0[0]:6.0f}s] {msg}", flush=True)


def load_cloud(path):
    log(f"reading {path.name}")
    pc = o3d.io.read_point_cloud(str(path), format="xyzrgb")  # colours come through as 0..255
    rgb = np.asarray(pc.colors)
    return np.asarray(pc.points), rgb / 255.0 if rgb.max() > 1.0 else rgb


def face_dirs(f, R):
    """Pano-frame unit directions for every pixel of cube face f at R x R (row-major). Layout: see viewer/panotex.js."""
    c = (np.arange(R) + 0.5) / R * 2 - 1
    u, v = np.meshgrid(c, c)  # u: column, v: row (row 0 = top of the image)
    one = np.ones_like(u)
    l = {0: (v, -u, one), 5: (-v, -u, -one), 1: (one, -u, -v), 3: (-one, u, -v), 4: (u, one, -v), 2: (-u, -one, -v)}[f]
    l = np.stack(l, -1).reshape(-1, 3)
    n = np.linalg.norm(l, axis=1, keepdims=True)
    return l / n, 1.0 / n[:, 0]  # direction, cos to the face axis (planar depth = range * cos)


def depth_points(root, panos, scene, res, model_name):
    """Points for the parts of each photo the scanner missed, at monocular-depth positions."""
    import torch
    from transformers import AutoImageProcessor, AutoModelForDepthEstimation

    log(f"loading depth model {model_name}")
    proc = AutoImageProcessor.from_pretrained(model_name)
    model = AutoModelForDepthEstimation.from_pretrained(model_name).eval()
    torch.set_num_threads(max(1, torch.get_num_threads()))

    P, C, N = [], [], []
    for pi, p in enumerate(panos):
        rot = Rotation.from_quat([p["rotation"][k] for k in "xyzw"])
        pos = np.array([p["position"][k] for k in "xyz"])
        for f in range(5):  # face 5 looks straight down at the tripod
            img = Image.open(root / "panos" / p["id"] / f"skybox{f}.jpg").convert("RGB")
            with torch.no_grad():
                out = model(**proc(images=img, return_tensors="pt")).predicted_depth
            pred = torch.nn.functional.interpolate(out[None], size=(res, res), mode="bicubic", align_corners=False)[0, 0].numpy()
            pred = pred.reshape(-1).astype(np.float64)

            l, cos = face_dirs(f, res)
            dirs = rot.apply(l)
            rays = np.hstack([np.broadcast_to(pos, dirs.shape), dirs]).astype(np.float32)
            t = scene.cast_rays(o3d.core.Tensor(rays))["t_hit"].numpy().astype(np.float64)
            mesh_z = t * cos  # planar depth, same as the model's

            # Line the model up with the scanner: mesh_z ~ a * pred + b, refit on inliers.
            ok = np.isfinite(mesh_z) & (mesh_z > 0.3) & (mesh_z < 8)
            if ok.sum() < 0.1 * len(ok):
                continue
            # Start from the median ratio: on 90-degree cube faces the "metric" model is off by ~2-3x.
            a, b = float(np.median(mesh_z[ok] / pred[ok])), 0.0
            for _ in range(6):
                fit = a * pred + b
                inl = ok & (np.abs(fit - mesh_z) < 0.08 * mesh_z + 0.03)
                if inl.sum() < 1000:
                    break
                a, b = np.polyfit(pred[inl], mesh_z[inl], 1)
            fit = a * pred + b
            agree = inl.mean() / ok.mean()

            # Holes: the scanner saw nothing there, or something well behind what the photo shows.
            hole = (~np.isfinite(mesh_z) | (mesh_z > 1.25 * fit + 0.2)) & (fit > 0.3) & (fit < 6)
            hole = hole.reshape(res, res)
            # Not across depth edges (the model blurs them into "flying" points between objects).
            fz = fit.reshape(res, res)
            gy, gx = np.gradient(fz)
            hole &= np.hypot(gx, gy) < 0.02 * fz * (512 / res) + 0.004
            hole = ndimage.binary_opening(hole, iterations=2)
            lab, n = ndimage.label(hole)
            if n:
                sizes = ndimage.sum(hole, lab, np.arange(1, n + 1))
                hole = np.isin(lab, 1 + np.nonzero(sizes >= (res / 512) ** 2 * 150)[0])
            hole = hole.reshape(-1)
            log(f"pano {p.get('label', pi)} face {f}: depth fit z = {a:.2f} * pred + {b:+.2f} "
                f"({100 * agree:.0f}% agree), {100 * hole.mean():.1f}% hole pixels")
            if not hole.any():
                continue

            r = fit[hole] / cos[hole]
            pts = pos + dirs[hole] * r[:, None]
            col = np.asarray(img.resize((res, res), Image.BILINEAR), np.float64).reshape(-1, 3)[hole] / 255
            # Normals from the depth map itself, facing the pano.
            P3 = (pos + dirs * (fit / cos)[:, None]).reshape(res, res, 3)
            n3 = np.cross(np.gradient(P3, axis=1), np.gradient(P3, axis=0)).reshape(-1, 3)[hole]
            n3 /= np.maximum(np.linalg.norm(n3, axis=1, keepdims=True), 1e-12)
            n3 *= -np.sign((n3 * dirs[hole]).sum(1, keepdims=True) + 1e-12)
            P.append(pts), C.append(col), N.append(n3)
    if not P:
        return np.zeros((0, 3)), np.zeros((0, 3)), np.zeros((0, 3))
    return np.concatenate(P), np.concatenate(C), np.concatenate(N)


def orient_to_panos(pts, normals, panos, scene):
    """Flip each normal to face the nearest pano that sees the point (scanner points were all seen from one)."""
    best = np.full(len(pts), np.inf)
    target = np.zeros_like(pts)
    for p in panos:
        pos = np.array([p["position"][k] for k in "xyz"])
        d = pts - pos
        r = np.linalg.norm(d, axis=1)
        dirs = d / np.maximum(r, 1e-9)[:, None]
        vis = np.zeros(len(pts), bool)
        for s in range(0, len(pts), 2_000_000):
            rays = np.hstack([np.broadcast_to(pos, dirs[s:s + 2_000_000].shape), dirs[s:s + 2_000_000]]).astype(np.float32)
            t = scene.cast_rays(o3d.core.Tensor(rays))["t_hit"].numpy()
            vis[s:s + 2_000_000] = t >= r[s:s + 2_000_000] - 0.05
        score = np.where(vis, r, r + 100)  # visible panos first, then nearest
        m = score < best
        best[m] = score[m]
        target[m] = pos
    flip = ((target - pts) * normals).sum(1) < 0
    normals[flip] *= -1
    return normals


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sid", nargs="?", default="UzwrJ9TbQuG")
    ap.add_argument("--voxel", type=float, default=0.008, help="thin the cloud to this grid (m), default 0.008")
    ap.add_argument("--poisson", type=int, default=11, help="Poisson octree depth (default 11)")
    ap.add_argument("--trim", type=float, default=0.03, help="drop surface farther than this from any point (m)")
    ap.add_argument("--faces", type=int, default=800_000, help="decimate to about this many triangles")
    ap.add_argument("--no-depth", action="store_true", help="skip the monocular depth hole filling")
    ap.add_argument("--depth-res", type=int, default=512, help="points per cube face side from the depth model")
    ap.add_argument("--depth-model", default=DEPTH_MODEL)
    ap.add_argument("--save-points", action="store_true", help="also write rebuilt/points.ply (large) for inspection")
    args = ap.parse_args()

    root = HERE / "data" / args.sid
    meta = json.loads((root / "meta.json").read_text(encoding="utf-8"))
    cloud = root / "cloud.xyz"
    if not cloud.exists():
        raise SystemExit(f"No {cloud}. Run: py -3.13 get_mesh.py {args.sid} --cloud")
    panos = json.loads((root / "panos" / "panos.json").read_text(encoding="utf-8"))["panos"]

    # The MatterPak mesh: what the scanner saw, used for visibility and to line up the depth model.
    V, _, F, *_ = parse_obj(root / meta["obj"])
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.core.Tensor(V.astype(np.float32)), o3d.core.Tensor(F.astype(np.uint32)))

    # 1. Scanner points.
    xyz, rgb = load_cloud(cloud)
    pc = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(xyz))
    pc.colors = o3d.utility.Vector3dVector(rgb)
    del xyz, rgb
    pc = pc.voxel_down_sample(args.voxel)
    pc, _ = pc.remove_statistical_outlier(nb_neighbors=16, std_ratio=2.5)
    log(f"{len(pc.points):,} scanner points after thinning to {args.voxel * 1000:.0f} mm")
    pc.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(radius=4 * args.voxel, max_nn=30))
    pts = np.asarray(pc.points)
    nrm = orient_to_panos(pts, np.asarray(pc.normals).copy(), panos, scene)
    cols = np.asarray(pc.colors)

    # 2. Monocular depth for the holes.
    n_depth = 0
    if not args.no_depth:
        dp, dc, dn = depth_points(root, panos, scene, args.depth_res, args.depth_model)
        if len(dp):
            # Thin them to the same grid, and only where the scanner has no point nearby.
            dpc = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(dp))
            dpc.colors, dpc.normals = o3d.utility.Vector3dVector(dc), o3d.utility.Vector3dVector(dn)
            dpc = dpc.voxel_down_sample(args.voxel * 1.5)
            dp, dc, dn = np.asarray(dpc.points), np.asarray(dpc.colors), np.asarray(dpc.normals)
            dist, _ = cKDTree(pts).query(dp, distance_upper_bound=0.05)
            keep = ~np.isfinite(dist)
            dp, dc, dn = dp[keep], dc[keep], dn[keep] / np.linalg.norm(dn[keep], axis=1, keepdims=True)
            n_depth = len(dp)
            log(f"{n_depth:,} points from monocular depth in scanner holes")
            pts, nrm, cols = np.vstack([pts, dp]), np.vstack([nrm, dn]), np.vstack([cols, dc])
    out = root / "rebuilt"
    out.mkdir(exist_ok=True)
    allpc = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(pts))
    allpc.normals, allpc.colors = o3d.utility.Vector3dVector(nrm), o3d.utility.Vector3dVector(cols)
    if args.save_points:
        o3d.io.write_point_cloud(str(out / "points.ply"), allpc)

    # 3. Surface.
    log(f"Poisson reconstruction, depth {args.poisson} ({len(pts):,} points)…")
    mesh, dens = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(allpc, depth=args.poisson, scale=1.05, linear_fit=True)
    log(f"{len(mesh.triangles):,} triangles before trimming")
    mv = np.asarray(mesh.vertices)
    dist, idx = cKDTree(pts).query(mv, distance_upper_bound=args.trim)
    mesh.remove_vertices_by_mask(~np.isfinite(dist))
    clusters, counts, _ = mesh.cluster_connected_triangles()
    clusters, counts = np.asarray(clusters), np.asarray(counts)
    mesh.remove_triangles_by_mask(counts[clusters] < 200)
    mesh.remove_unreferenced_vertices()
    log(f"{len(mesh.triangles):,} triangles after cutting away guessed surface and fragments")
    if len(mesh.triangles) > args.faces:
        mesh = mesh.simplify_quadric_decimation(args.faces)
        log(f"decimated to {len(mesh.triangles):,} triangles")
    mesh.remove_degenerate_triangles()
    mesh.remove_unreferenced_vertices()
    mv = np.asarray(mesh.vertices)
    _, idx = cKDTree(pts).query(mv, k=4)
    vc = cols[idx].mean(1)

    with open(out / "mesh.obj", "w", encoding="utf-8") as fh:
        fh.write("# rebuilt from the point cloud (+ monocular depth in holes) by rebuild_mesh.py\n")
        fh.write("".join(f"v {x:.5f} {y:.5f} {z:.5f} {r:.3f} {g:.3f} {b:.3f}\n" for (x, y, z), (r, g, b) in zip(mv, vc)))
        fh.write("".join(f"f {a} {b} {c}\n" for a, b, c in np.asarray(mesh.triangles) + 1))
    meta["rebuilt"] = {"obj": "rebuilt/mesh.obj", "triangles": len(mesh.triangles), "depth_points": n_depth,
                       "poisson_depth": args.poisson, "voxel_m": args.voxel}
    (root / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    log(f"done -> {out / 'mesh.obj'}  (next: py -3.13 bake_textures.py {args.sid} --mesh rebuilt)")


if __name__ == "__main__":
    main()
