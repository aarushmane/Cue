"""Clean a baked mesh so what you see matches what you bump into, keeping its photo textures.

    py -3.13 clean_mesh.py                 # J&B Food Market (UzwrJ9TbQuG), cleans meta["baked"]
    py -3.13 clean_mesh.py <sid> --dry-run # only report
    py -3.13 clean_mesh.py --matterpak-from <folder with the MatterPak obj/mtl/jpgs>   # copy them in first if missing

The walkable simulation's collisions come from the scanner's own (MatterPak) mesh, so the visible mesh must not
lose anything the scanner saw, and must not show things it never saw:
  1. Keep: every connected piece of the baked mesh that the scanner backs (>= --backed of its vertices within
     --near of the MatterPak surface), whatever its size or floor contact. The main surface is always kept.
  2. Drop: unbacked pieces (Poisson / depth-model blobs floating in the air) and stretched triangles (an edge
     longer than --max-edge, membranes hanging across gaps).
  3. Patch: MatterPak triangles in the collision band (floor + 0.15 .. 1.9 m, as in lib/wayfinding/walkable.ts)
     that are farther than --patch-gap from the cleaned surface are appended with the MatterPak's own textures,
     so anything that blocks you is drawn. Patched triangles are grouped into objects -> objects.json, which
     complete_objects.py can replace with AI-generated 3D models.
Writes <bake folder>/mesh_clean.obj + mesh_clean.mtl (+ patch_NNN.jpg), points meta["baked"] at them and keeps the
originals as meta["baked"]["raw_obj"] / ["raw_mtl"].
"""
import argparse
import json
import shutil
from pathlib import Path

import numpy as np
import open3d as o3d
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

from bake_textures import log, mtl_maps, parse_obj

HERE = Path(__file__).resolve().parent
BAND = (0.15, 1.9)  # obstacle band above the floor, as buildWalkGrid


def pieces(V, F, weld_m=0.001):
    """Connected pieces after welding vertices that share a position (UV seams split the vertex list)."""
    _, weld = np.unique(np.round(V / weld_m).astype(np.int64), axis=0, return_inverse=True)
    W = weld.ravel()[F]
    n = int(W.max()) + 1
    rows = np.concatenate([W[:, 0], W[:, 1]])
    cols = np.concatenate([W[:, 1], W[:, 2]])
    k, label = connected_components(coo_matrix((np.ones(len(rows)), (rows, cols)), shape=(n, n)), directed=False)
    return k, label[W[:, 0]]


def surface_points(V, F, per_m2=4000, seed=0):
    """Points spread over the triangles by area (vertices alone miss the middle of big triangles). Deterministic."""
    rng = np.random.default_rng(seed)
    A = V[F]
    area = np.linalg.norm(np.cross(A[:, 1] - A[:, 0], A[:, 2] - A[:, 0]), axis=1) / 2
    n = max(1, int(area.sum() * per_m2))
    tri = rng.choice(len(F), n, p=area / area.sum())
    r1, r2 = rng.random(n), rng.random(n)
    s = np.sqrt(r1)
    w = np.stack([1 - s, s * (1 - r2), s * r2], 1)
    return np.einsum("nk,nkd->nd", w, A[tri])


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sid", nargs="?", default="UzwrJ9TbQuG")
    ap.add_argument("--near", type=float, default=0.05, help="a vertex this close (m) to the scan is backed")
    ap.add_argument("--backed", type=float, default=0.3, help="share of backed vertices that keeps a piece")
    ap.add_argument("--max-edge", type=float, default=0.2, help="drop triangles with a longer edge (m)")
    ap.add_argument("--patch-gap", type=float, default=0.06, help="patch scanned surface farther than this from the clean mesh (m)")
    ap.add_argument("--object-size", type=float, default=0.3, help="patched groups at least this big (m) are listed as objects")
    ap.add_argument("--matterpak-from", type=Path, help="folder to copy the MatterPak obj/mtl/jpgs from if they are missing")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    root = HERE / "data" / args.sid
    meta_path = root / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    baked = meta.get("baked") or {}
    src_obj = baked.get("raw_obj") or baked.get("obj")
    src_mtl = baked.get("raw_mtl") or baked.get("mtl")
    if not src_obj or not src_mtl:
        raise SystemExit("No baked mesh in meta.json. Run bake_textures.py first.")
    mp_obj, mp_mtl = root / meta["obj"], root / meta["mtl"]
    if not mp_obj.exists():
        if not args.matterpak_from:
            raise SystemExit(f"No MatterPak mesh at {mp_obj}. Run get_mesh.py, or pass --matterpak-from <folder>.")
        stem = Path(meta["obj"]).stem
        for f in args.matterpak_from.glob(f"{stem}*"):
            if f.suffix.lower() in (".obj", ".mtl", ".jpg", ".jpeg", ".png"):
                shutil.copy2(f, root / f.name)
        log(f"copied MatterPak files from {args.matterpak_from}")

    log(f"reading {src_obj}")
    V, VT, F, *_ = parse_obj(root / src_obj)
    log(f"reading MatterPak {mp_obj.name}")
    MV, MVT, MF, MFT, MFM, mnames, _ = parse_obj(mp_obj)
    mmaps = mtl_maps(mp_mtl)
    scan = o3d.t.geometry.RaycastingScene()
    scan.add_triangles(o3d.core.Tensor(MV.astype(np.float32)), o3d.core.Tensor(MF.astype(np.uint32)))
    floor = float(np.percentile(V[:, 2], 1))

    # 1-2. Keep what the scanner saw; drop the rest and stretched triangles.
    k, piece = pieces(V, F)
    sizes = np.bincount(piece, minlength=k)
    main_piece = int(np.argmax(sizes))
    near = scan.compute_distance(o3d.core.Tensor(V.astype(np.float32))).numpy() < args.near
    vert_piece = np.full(len(V), -1)
    vert_piece[F.ravel()] = np.repeat(piece, 3)
    used = vert_piece >= 0
    backed_share = np.bincount(vert_piece[used], weights=near[used], minlength=k) / np.maximum(np.bincount(vert_piece[used], minlength=k), 1)
    backed = backed_share >= args.backed
    backed[main_piece] = True
    A = V[F]
    edge = np.max(np.stack([np.linalg.norm(A[:, i] - A[:, (i + 1) % 3], axis=1) for i in range(3)]), axis=0)
    stretched = edge > args.max_edge
    drop = ~backed[piece] | stretched
    log(f"{len(F):,} triangles in {k} pieces; kept {int(backed.sum())} backed pieces; dropped {int((~backed).sum())} "
        f"unbacked pieces ({int((~backed[piece]).sum()):,} triangles) and {int(stretched.sum()):,} stretched")

    # 3. Patch scanned obstacle surface the clean mesh doesn't draw.
    keep = F[~drop]
    tree = cKDTree(surface_points(V, keep))
    MC = MV[MF].mean(axis=1)
    in_band = (MC[:, 2] > floor + BAND[0]) & (MC[:, 2] < floor + BAND[1])
    gap, _ = tree.query(MC, distance_upper_bound=args.patch_gap)
    patch = in_band & ~np.isfinite(gap)
    P = np.nonzero(patch)[0]
    T = MV[MF[P]]
    area = np.linalg.norm(np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]), axis=1).sum() / 2
    log(f"patching {len(P):,} MatterPak triangles ({area:.1f} m2) that block walking but weren't drawn")

    objects = []
    if len(P):
        pk, plabel = pieces(MV, MF[P], weld_m=0.002)
        for g in np.unique(plabel):
            tris = P[plabel == g]
            pts = MV[MF[tris]].reshape(-1, 3)
            lo, hi = pts.min(0), pts.max(0)
            if max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) < args.object_size:
                continue
            objects.append({"id": f"obj{len(objects):03d}", "triangles": int(len(tris)), "bbox": [lo.round(3).tolist(), hi.round(3).tolist()],
                            "mp_faces": tris.tolist()})
        log(f"{len(objects)} patched objects >= {args.object_size} m: " + ", ".join(
            f"{o['id']} {np.round(np.subtract(o['bbox'][1], o['bbox'][0]), 2).tolist()}" for o in objects[:12]) + (" …" if len(objects) > 12 else ""))
    # Keep AI results from complete_objects.py for objects that came out the same; accepted ones replace their patch.
    out_dir = (root / src_obj).parent
    previous = {}
    if (out_dir / "objects.json").exists():
        previous = {o["id"]: o for o in json.loads((out_dir / "objects.json").read_text(encoding="utf-8"))["objects"]}
    ai = []
    for o in objects:
        old = previous.get(o["id"])
        if old and old.get("ai") and old.get("bbox") == o["bbox"]:
            o["ai"] = old["ai"]
            work = out_dir / "objects" / o["id"]
            if o["ai"].get("status") == "accepted" and (work / "aligned.obj").exists() and (work / "texture.jpg").exists():
                ai.append(o)
    if ai:
        replaced = np.zeros(len(MF), bool)
        for o in ai:
            replaced[o["mp_faces"]] = True
        P = P[~replaced[P]]
        log(f"{len(ai)} AI objects replace their scan patch: " + ", ".join(o["id"] for o in ai))
    if args.dry_run:
        return

    # Write: the baked OBJ minus dropped faces, then the patch with its own vertices, UVs and materials.
    out_obj, out_mtl = out_dir / "mesh_clean.obj", out_dir / "mesh_clean.mtl"
    face = 0
    with open(root / src_obj, encoding="utf-8", errors="replace") as fh, open(out_obj, "w", encoding="utf-8") as dst:
        dst.write("# cleaned by clean_mesh.py (unbacked fragments and stretched triangles removed, scan patches added)\n")
        for line in fh:
            if line.startswith("mtllib"):
                dst.write("mtllib mesh_clean.mtl\n")
                continue
            if line.startswith("f "):
                count = len(line.split()) - 3
                skip = drop[face:face + count].any()
                face += count
                if skip:
                    continue
            dst.write(line)
        if face != len(F):
            raise SystemExit(f"Face count mismatch ({face} vs {len(F)}).")
        if len(P):
            pv, pv_inv = np.unique(MF[P].ravel(), return_inverse=True)
            pt, pt_inv = np.unique(MFT[P].ravel(), return_inverse=True)
            fv = pv_inv.reshape(-1, 3) + len(V) + 1
            ft = pt_inv.reshape(-1, 3) + len(VT) + 1
            dst.write("# scan patch (MatterPak triangles)\n")
            dst.write("".join(f"v {x:.5f} {y:.5f} {z:.5f}\n" for x, y, z in MV[pv]))
            dst.write("".join(f"vt {u:.6f} {v:.6f}\n" for u, v in MVT[pt]))
            mats = MFM[P]
            for m in np.unique(mats):
                dst.write(f"usemtl patch_{m:03d}\n")
                sel = np.nonzero(mats == m)[0]
                dst.write("".join(f"f {a}/{ta} {b}/{tb} {c}/{tc}\n" for (a, b, c), (ta, tb, tc) in zip(fv[sel], ft[sel])))
        nv = len(V) + (len(pv) if len(P) else 0)
        nt = len(VT) + (len(pt) if len(P) else 0)
        for o in ai:
            AV, AT, AF, AFT, *_ = parse_obj(out_dir / "objects" / o["id"] / "aligned.obj")
            dst.write(f"# AI object {o['id']} (complete_objects.py)\n")
            dst.write("".join(f"v {x:.5f} {y:.5f} {z:.5f}\n" for x, y, z in AV))
            dst.write("".join(f"vt {u:.6f} {v:.6f}\n" for u, v in AT))
            dst.write(f"usemtl ai_{o['id']}\n")
            dst.write("".join(f"f {a}/{ta} {b}/{tb} {c}/{tc}\n" for (a, b, c), (ta, tb, tc) in zip(AF + nv + 1, AFT + nt + 1)))
            nv += len(AV)
            nt += len(AT)
    mtl_text = (root / src_mtl).read_text(encoding="utf-8")
    extra = []
    for m in np.unique(MFM[P]) if len(P) else []:
        tex = mmaps.get(mnames[m])
        if not tex or not tex.exists():
            continue
        name = f"patch_{m:03d}{tex.suffix.lower()}"
        shutil.copy2(tex, out_dir / name)
        extra += [f"newmtl patch_{m:03d}", "Ka 1 1 1", "Kd 1 1 1", f"map_Kd {name}", ""]
    for o in ai:
        shutil.copy2(out_dir / "objects" / o["id"] / "texture.jpg", out_dir / f"ai_{o['id']}.jpg")
        extra += [f"newmtl ai_{o['id']}", "Ka 1 1 1", "Kd 1 1 1", f"map_Kd ai_{o['id']}.jpg", ""]
    out_mtl.write_text(mtl_text.rstrip() + "\n\n" + "\n".join(extra), encoding="utf-8")
    (out_dir / "objects.json").write_text(json.dumps({"floor_z": floor, "matterpak": meta["obj"], "objects": objects}), encoding="utf-8")

    baked["raw_obj"], baked["raw_mtl"] = src_obj, src_mtl
    baked["obj"] = str(out_obj.relative_to(root)).replace("\\", "/")
    baked["mtl"] = str(out_mtl.relative_to(root)).replace("\\", "/")
    baked["cleaned"] = {"dropped": int(drop.sum()), "patched": int(len(P)), "objects": len(objects), "ai_objects": len(ai),
                        "near_m": args.near, "backed": args.backed, "max_edge_m": args.max_edge, "patch_gap_m": args.patch_gap}
    meta["baked"] = baked
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    log(f"done -> {out_obj}")


if __name__ == "__main__":
    main()
