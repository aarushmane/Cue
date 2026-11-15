"""Bake sharper textures for a model's mesh from its 4k pano photos.

    py -3.13 bake_textures.py                    # J&B Food Market (UzwrJ9TbQuG)
    py -3.13 bake_textures.py <sid> --texels 100 # texel budget in millions (GPU memory ~ 5.3 MB per million)

Needs the mesh (get_mesh.py) and the photos (fetch_panos.py), plus: pip install pillow open3d xatlas scipy

Steps:
  1. For each triangle, find how sharp the best pano photo of it is (Open3D ray casting for occlusion).
  2. Unwrap the mesh into fresh 4096x4096 atlases with xatlas. Each triangle
     gets texels as fine as its sharpest photo, down to a floor set by the texel budget.
  3. For every texel: cast a ray from each pano to check it really sees that spot, sample the 4k photo
     with filtering matched to the texel size, and blend the panos, favouring the sharpest view.
     Spots no pano sees keep the MatterPak texture.
Writes data/<sid>/baked/ (OBJ + MTL + JPG atlases) and adds "baked" to meta.json for the viewer.
"""
import argparse
import json
import math
import shutil
import time
from pathlib import Path

import numpy as np
import open3d as o3d
import xatlas
from PIL import Image
from scipy import ndimage
from scipy.spatial.transform import Rotation

HERE = Path(__file__).resolve().parent
ATLAS = 4096
LEVELS = 5  # photo mip levels: 4096 .. 256


def log(msg, t0=[time.time()]):
    print(f"[{time.time() - t0[0]:6.0f}s] {msg}", flush=True)


def parse_obj(path):
    V, VT, F, FT, FM, names, VC = [], [], [], [], [], [], []
    cur = 0
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if line.startswith("v "):
                s = line.split()
                V.append(s[1:4])
                if len(s) >= 7:
                    VC.append(s[4:7])  # vertex colour (rebuild_mesh.py writes these)
            elif line.startswith("vt "):
                VT.append(line.split()[1:3])
            elif line.startswith("usemtl"):
                n = line.split(None, 1)[1].strip()
                if n not in names:
                    names.append(n)
                cur = names.index(n)
            elif line.startswith("f "):
                p = [x.split("/") for x in line.split()[1:]]
                for k in range(1, len(p) - 1):  # fan-triangulate, in case
                    tri = (p[0], p[k], p[k + 1])
                    F.append([int(a[0]) for a in tri])
                    FT.append([int(a[1]) if len(a) > 1 and a[1] else 1 for a in tri])
                    FM.append(cur)
    VC = np.array(VC, np.float64) if len(VC) == len(V) else None
    return (np.array(V, np.float64), np.array(VT, np.float64), np.array(F, np.int64) - 1,
            np.array(FT, np.int64) - 1, np.array(FM, np.int64), names, VC)


def mtl_maps(path):
    maps, cur = {}, None
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        parts = line.split(None, 1)
        if not parts:
            continue
        if parts[0] == "newmtl":
            cur = parts[1].strip()
        elif parts[0] == "map_Kd" and cur:
            maps[cur] = path.parent / parts[1].strip()
    return maps


class Pano:
    def __init__(self, folder, p):
        self.folder = folder
        self.pos = np.array([p["position"][k] for k in "xyz"])
        q = p["rotation"]
        self.to_local = Rotation.from_quat([q["x"], q["y"], q["z"], q["w"]]).inv()  # model -> pano frame
        self.levels = None

    def load(self):
        faces = [Image.open(self.folder / f"skybox{f}.jpg").convert("RGB") for f in range(6)]
        self.res = faces[0].width
        self.levels = []
        for _ in range(LEVELS):
            self.levels.append(np.stack([np.asarray(im) for im in faces]))
            faces = [im.reduce(2) for im in faces]

    def unload(self):
        self.levels = None


def cube_lookup(l):
    """Pano-frame direction -> (face, u, v) with u, v in [-1, 1]. Layout: see viewer/panotex.js."""
    a = np.abs(l)
    x, y, z = l[:, 0], l[:, 1], l[:, 2]
    face = np.empty(len(l), np.int64)
    u = np.empty(len(l))
    v = np.empty(len(l))
    zm = (a[:, 2] >= a[:, 0]) & (a[:, 2] >= a[:, 1])
    xm = ~zm & (a[:, 0] >= a[:, 1])
    ym = ~zm & ~xm
    for m, f, uu, vv, d in (
        (zm & (z > 0), 0, -y, x, a[:, 2]), (zm & (z <= 0), 5, -y, -x, a[:, 2]),
        (xm & (x > 0), 1, -y, -z, a[:, 0]), (xm & (x <= 0), 3, y, -z, a[:, 0]),
        (ym & (y > 0), 4, x, -z, a[:, 1]), (ym & (y <= 0), 2, -x, -z, a[:, 1]),
    ):
        face[m] = f
        u[m] = uu[m] / d[m]
        v[m] = vv[m] / d[m]
    return face, u, v


def bilinear(img, face, x, y):
    """img (6, H, W, 3) uint8; x, y pixel coords (centre of pixel 0 = 0.0). Returns float32 (n, 3)."""
    H, W = img.shape[1:3]
    x = np.clip(x, 0, W - 1)
    y = np.clip(y, 0, H - 1)
    x0 = np.minimum(x.astype(np.int64), W - 2)
    y0 = np.minimum(y.astype(np.int64), H - 2)
    fx = (x - x0)[:, None].astype(np.float32)
    fy = (y - y0)[:, None].astype(np.float32)
    c00 = img[face, y0, x0].astype(np.float32)
    c01 = img[face, y0, x0 + 1].astype(np.float32)
    c10 = img[face, y0 + 1, x0].astype(np.float32)
    c11 = img[face, y0 + 1, x0 + 1].astype(np.float32)
    return (c00 * (1 - fx) + c01 * fx) * (1 - fy) + (c10 * (1 - fx) + c11 * fx) * fy


def sample_pano(p, face, u, v, lod):
    """Trilinear sample of the photo pyramid."""
    out = np.zeros((len(face), 3), np.float32)
    lod = np.clip(lod, 0, LEVELS - 1)
    l0 = np.floor(lod).astype(np.int64)
    t = (lod - l0)[:, None].astype(np.float32)
    for L in range(LEVELS):
        m = l0 == L
        if not m.any():
            continue
        lo = [L, min(L + 1, LEVELS - 1)]
        cols = []
        for lv in lo:
            res = p.levels[lv].shape[1]
            cols.append(bilinear(p.levels[lv], face[m], (u[m] * 0.5 + 0.5) * res - 0.5, (v[m] * 0.5 + 0.5) * res - 0.5))
        out[m] = cols[0] * (1 - t[m]) + cols[1] * t[m]
    return out


def raster(tri, W):
    """Rasterise triangles given in pixel coords (k, 3, 2). Returns pixel index, triangle index, barycentrics."""
    pix, tid, bar = [], [], []
    a, b, c = tri[:, 0], tri[:, 1], tri[:, 2]
    den = (b[:, 1] - c[:, 1]) * (a[:, 0] - c[:, 0]) + (c[:, 0] - b[:, 0]) * (a[:, 1] - c[:, 1])
    ok = np.abs(den) > 1e-12
    x0 = np.ceil(tri[:, :, 0].min(1) - 0.5).astype(np.int64)
    x1 = np.floor(tri[:, :, 0].max(1) - 0.5).astype(np.int64)
    y0 = np.ceil(tri[:, :, 1].min(1) - 0.5).astype(np.int64)
    y1 = np.floor(tri[:, :, 1].max(1) - 0.5).astype(np.int64)
    size = np.maximum(x1 - x0, y1 - y0) + 1
    ok &= size > 0
    bucket = 2 ** np.ceil(np.log2(np.maximum(size, 1))).astype(np.int64)
    for B in np.unique(bucket[ok]):
        ids = np.nonzero(ok & (bucket == B))[0]
        step = max(1, 4_000_000 // int(B * B))
        for s in range(0, len(ids), step):
            i = ids[s:s + step]
            g = np.arange(B)
            gx = x0[i, None, None] + g[None, None, :]
            gy = y0[i, None, None] + g[None, :, None]
            cx, cy = gx + 0.5, gy + 0.5
            ax, ay = a[i, 0, None, None], a[i, 1, None, None]
            bx, by = b[i, 0, None, None], b[i, 1, None, None]
            ccx, ccy = c[i, 0, None, None], c[i, 1, None, None]
            d = den[i, None, None]
            l0 = ((by - ccy) * (cx - ccx) + (ccx - bx) * (cy - ccy)) / d
            l1 = ((ccy - ay) * (cx - ccx) + (ax - ccx) * (cy - ccy)) / d
            l2 = 1 - l0 - l1
            m = (l0 >= -1e-6) & (l1 >= -1e-6) & (l2 >= -1e-6) & (gx <= x1[i, None, None]) & (gy <= y1[i, None, None])
            m &= (gx >= 0) & (gx < W) & (gy >= 0) & (gy < W)
            pix.append((gy * W + gx)[m])
            tid.append(np.broadcast_to(i[:, None, None], m.shape)[m])
            bar.append(np.stack([l0[m], l1[m], l2[m]], 1).astype(np.float32))
    pix, tid, bar = np.concatenate(pix), np.concatenate(tid), np.concatenate(bar)
    pix, first = np.unique(pix, return_index=True)
    return pix, tid[first], bar[first]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sid", nargs="?", default="UzwrJ9TbQuG")
    ap.add_argument("--texels", type=float, default=100, help="texel budget in millions (default 100, like the MatterPak)")
    ap.add_argument("--mesh", choices=["matterpak", "rebuilt"], default="matterpak",
                    help="bake onto the MatterPak mesh (default) or the one from rebuild_mesh.py")
    args = ap.parse_args()
    root = HERE / "data" / args.sid
    meta = json.loads((root / "meta.json").read_text(encoding="utf-8"))
    plist = json.loads((root / "panos" / "panos.json").read_text(encoding="utf-8"))["panos"]
    panos = [Pano(root / "panos" / p["id"], p) for p in plist]
    if args.mesh == "rebuilt":
        if "rebuilt" not in meta:
            raise SystemExit(f"No rebuilt mesh yet. Run: py -3.13 rebuild_mesh.py {args.sid}")
        obj_path, mtl_path, out_name = meta["rebuilt"]["obj"], None, "baked_rebuilt"
    else:
        obj_path, mtl_path, out_name = meta["obj"], meta.get("mtl"), "baked"
    out = root / out_name
    tmp = out / "tmp"
    shutil.rmtree(out, ignore_errors=True)
    tmp.mkdir(parents=True)

    log(f"reading mesh {obj_path}")
    V, VT, F, FT, FM, names, VC = parse_obj(root / obj_path)
    maps = mtl_maps(root / mtl_path) if mtl_path else {}
    A = V[F]
    Nf = np.cross(A[:, 1] - A[:, 0], A[:, 2] - A[:, 0])
    area = np.linalg.norm(Nf, axis=1) / 2
    Nf /= np.maximum(2 * area, 1e-12)[:, None]
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.core.Tensor(V.astype(np.float32)), o3d.core.Tensor(F.astype(np.uint32)))
    log(f"{len(F):,} triangles, {area.sum():.0f} m2, {len(panos)} panos")

    def visible(p, pts, tri):
        d = pts - p.pos
        r = np.linalg.norm(d, axis=1)
        dirs = d / np.maximum(r, 1e-9)[:, None]
        rays = np.hstack([np.broadcast_to(p.pos, d.shape), dirs]).astype(np.float32)
        hit = scene.cast_rays(o3d.core.Tensor(rays))
        t, prim = hit["t_hit"].numpy(), hit["primitive_ids"].numpy()
        return ((prim == tri) | (t >= r - 0.01)), r, dirs

    def photo_px_mm(p, l, r, cos):
        """Size of one photo pixel on the surface (mm), and the cube lookup."""
        face, u, v = cube_lookup(l)
        ang = (2.0 / p.res) / (1 + u * u + v * v) ** 0.75
        return r * ang * 1000 / np.sqrt(np.maximum(cos, 0.05)), face, u, v

    # 1. Sharpest photo pixel for each triangle (at its centre).
    best_px = np.full(len(F), np.inf)
    C = A.mean(1)
    for p in panos:
        p.res = Image.open(p.folder / "skybox0.jpg").width
        vis, r, dirs = visible(p, C, np.arange(len(F)))
        cos = np.abs((dirs * Nf).sum(1))
        l = p.to_local.apply(dirs)
        px, *_ = photo_px_mm(p, l, r, cos)
        best_px = np.minimum(best_px, np.where(vis & (cos > 0.05), px, np.inf))
    seen = np.isfinite(best_px)
    log(f"{100 * area[seen].sum() / area.sum():.1f}% of the surface is seen by a pano")

    # 2. Texel size per triangle: as fine as its sharpest photo, but no finer than a floor Tmin that the
    #    budget sets, in steps of sqrt(2). Unseen triangles keep about the MatterPak's density.
    budget = args.texels * 1e6 * 0.7  # xatlas packs about 70% full
    UNSEEN_MM = 4.0
    MAX_MM = 16.0

    def texel_for(Tmin):
        k = np.floor(2 * np.log2(np.clip(best_px, Tmin, MAX_MM) / Tmin))
        return np.where(seen, Tmin * 2 ** (k / 2), max(UNSEEN_MM, Tmin))

    lo_t, hi_t = 0.3, MAX_MM
    for _ in range(40):
        Tm = math.sqrt(lo_t * hi_t)
        need = (area * 1e6 / texel_for(Tm) ** 2).sum()
        lo_t, hi_t = (Tm, hi_t) if need > budget else (lo_t, Tm)
    tex_mm = texel_for(hi_t)
    T0 = float(tex_mm.max())  # xatlas density unit: the coarsest tier
    S = T0 / tex_mm  # per-triangle scale; tiers share a value
    S = np.round(S, 6)
    log(f"finest texel {hi_t:.2f} mm; " + ", ".join(f"{T0 / s:.2f} mm on {100 * area[S == s].sum() / area.sum():.0f}%" for s in np.unique(S)[::-1]))

    # The unwrap is the slow part (minutes) and only depends on the mesh and the budget, so it is cached.
    cache = root / ".bake_cache" / f"unwrap_{'' if args.mesh == 'matterpak' else args.mesh + '_'}{args.texels:g}.npz"
    if cache.exists() and cache.stat().st_mtime < (root / obj_path).stat().st_mtime:
        cache.unlink()  # the mesh changed since
    if cache.exists():
        z = np.load(cache)
        NV, NUV, NF, Fatlas, Forig = (z[k] for k in ("NV", "NUV", "NF", "Fatlas", "Forig"))
        log(f"reusing the unwrap from {cache.name}")
    else:
        log("unwrapping (xatlas)…")
        atlas = xatlas.Atlas()
        tiers = []
        for s in np.unique(S):
            fi = np.nonzero(S == s)[0]
            used, inv = np.unique(F[fi], return_inverse=True)
            atlas.add_mesh((V[used] * s).astype(np.float32), inv.reshape(-1, 3).astype(np.uint32))
            tiers.append((fi, used))
        po = xatlas.PackOptions()
        po.resolution = ATLAS
        po.texels_per_unit = 1000.0 / T0
        po.padding = 2
        po.bilinear = True
        po.blockAlign = True
        atlas.generate(xatlas.ChartOptions(), po)
        log(f"{atlas.atlas_count} atlases of {ATLAS}x{ATLAS}, {100 * float(np.mean(atlas.utilization)):.0f}% used")

        # Gather the new mesh: per original triangle, its atlas and uv (pixels); new vertex list.
        NV, NUV, NF, Fatlas, Forig = [], [], [], [], []
        base = 0
        for k, (fi, used) in enumerate(tiers):
            vmap, idx, uvs = atlas.get_mesh(k)
            aidx, _ = atlas.get_mesh_vertex_assignment(k)
            idx = idx.reshape(-1, 3).astype(np.int64)
            assert len(idx) == len(fi), "xatlas changed the triangle count"
            uvs = uvs.astype(np.float64)
            if uvs.max() <= 1.0001:
                uvs = uvs * ATLAS
            NV.append(V[used[vmap]])
            NUV.append(uvs)
            NF.append(idx + base)
            Fatlas.append(aidx[idx[:, 0]].astype(np.int64))
            Forig.append(fi)
            base += len(vmap)
        NV, NUV, NF = np.concatenate(NV), np.concatenate(NUV), np.concatenate(NF)
        Fatlas, Forig = np.concatenate(Fatlas), np.concatenate(Forig)
        cache.parent.mkdir(exist_ok=True)
        np.savez(cache, NV=NV, NUV=NUV, NF=NF, Fatlas=Fatlas, Forig=Forig)
    assert np.allclose(NV[NF], V[F[Forig]], atol=1e-5), "xatlas reordered triangles"
    n_atlas = int(Fatlas.max()) + 1

    # 3a. Rasterise each atlas: texel -> (original triangle, barycentrics). Kept on disk.
    texel_count = 0
    for k in range(n_atlas):
        tri_ids = np.nonzero(Fatlas == k)[0]
        pix, t, bar = raster(NUV[NF[tri_ids]], ATLAS)
        np.save(tmp / f"pix{k}.npy", pix)
        np.save(tmp / f"tri{k}.npy", Forig[tri_ids[t]])
        np.save(tmp / f"bar{k}.npy", bar)
        np.save(tmp / f"acc{k}.npy", np.zeros((len(pix), 4), np.float32))
        texel_count += len(pix)
    log(f"rasterised {texel_count / 1e6:.0f}M texels")

    # 3b. Each pano paints every texel it sees. Blend weight favours the sharpest view.
    CH = 1_500_000
    for pi, p in enumerate(panos):
        p.load()
        for k in range(n_atlas):
            tri = np.load(tmp / f"tri{k}.npy")
            bar = np.load(tmp / f"bar{k}.npy")
            acc = np.load(tmp / f"acc{k}.npy")
            for s in range(0, len(tri), CH):
                t, b = tri[s:s + CH], bar[s:s + CH]
                pts = np.einsum("nk,nkd->nd", b, A[t])
                d = pts - p.pos
                r = np.linalg.norm(d, axis=1)
                dirs = d / np.maximum(r, 1e-9)[:, None]
                cos = np.abs((dirs * Nf[t]).sum(1))
                cand = np.nonzero((cos > 0.05) & (r > 0.15) & (r < 15))[0]
                if not len(cand):
                    continue
                vis, *_ = visible(p, pts[cand], t[cand])
                cand = cand[vis]
                l = p.to_local.apply(dirs[cand])
                px, face, u, v = photo_px_mm(p, l, r[cand], cos[cand])
                texel_mm = T0 / S[t[cand]]
                col = sample_pano(p, face, u, v, np.log2(np.maximum(texel_mm / px, 1.0)))
                w = (1.0 / px) ** 4  # (1/px^2)^2: a 2x sharper view weighs 16x more
                w = w * np.where(l[:, 2] < -0.85, 0.01, 1.0)  # straight down: tripod and its shadow
                w = w * np.clip(cos[cand] / 0.25, 0, 1)  # fade out grazing views
                acc[s + cand, :3] += col * w[:, None]
                acc[s + cand, 3] += w
            np.save(tmp / f"acc{k}.npy", acc)
        p.unload()
        log(f"pano {pi + 1}/{len(panos)} painted")

    # 3c. Finish each atlas: normalise, fall back to the MatterPak texture, bleed into the gaps, save.
    old_imgs = {}
    lines_mtl = []
    for k in range(n_atlas):
        pix = np.load(tmp / f"pix{k}.npy")
        tri = np.load(tmp / f"tri{k}.npy")
        bar = np.load(tmp / f"bar{k}.npy")
        acc = np.load(tmp / f"acc{k}.npy")
        col = np.zeros((len(pix), 3), np.float32)
        has = acc[:, 3] > 0
        col[has] = acc[has, :3] / acc[has, 3:4]
        miss = np.nonzero(~has)[0]
        if len(miss) and VC is not None and not len(VT):  # rebuilt mesh: point-cloud vertex colours
            col[miss] = np.einsum("nk,nkd->nd", bar[miss], VC[F[tri[miss]]]) * 255
        elif len(miss):
            uv = np.einsum("nk,nkd->nd", bar[miss], VT[FT[tri[miss]]])
            mat = FM[tri[miss]]
            for m in np.unique(mat):
                path = maps.get(names[m])
                if not path:
                    continue
                if m not in old_imgs:
                    old_imgs[m] = np.asarray(Image.open(path).convert("RGB"))[None]
                img = old_imgs[m]
                sel = miss[mat == m]
                H, W = img.shape[1:3]
                uu = uv[mat == m]
                col[sel] = bilinear(img, np.zeros(len(sel), np.int64), (uu[:, 0] % 1) * W - 0.5, (1 - uu[:, 1] % 1) * H - 0.5)
        img = np.zeros((ATLAS * ATLAS, 3), np.uint8)
        img[pix] = np.clip(col + 0.5, 0, 255).astype(np.uint8)
        filled = np.zeros(ATLAS * ATLAS, bool)
        filled[pix] = True
        filled = filled.reshape(ATLAS, ATLAS)
        img = img.reshape(ATLAS, ATLAS, 3)
        near = ndimage.distance_transform_edt(~filled, return_distances=False, return_indices=True)
        img = img[near[0], near[1]]
        del near
        name = f"atlas_{k:02d}.jpg"
        Image.fromarray(img).save(out / name, quality=92, optimize=True)
        lines_mtl += [f"newmtl atlas_{k:02d}", "Ka 1 1 1", "Kd 1 1 1", f"map_Kd {name}", ""]
        log(f"atlas {k + 1}/{n_atlas}: {100 * has.mean():.0f}% of texels from photos")
    (out / "mesh.mtl").write_text("\n".join(lines_mtl), encoding="utf-8")

    with open(out / "mesh.obj", "w", encoding="utf-8") as fh:
        fh.write("# baked from pano photos by bake_textures.py\nmtllib mesh.mtl\n")
        fh.write("".join(f"v {x:.5f} {y:.5f} {z:.5f}\n" for x, y, z in NV))
        fh.write("".join(f"vt {u / ATLAS:.6f} {1 - v / ATLAS:.6f}\n" for u, v in NUV))
        for k in range(n_atlas):
            fh.write(f"usemtl atlas_{k:02d}\n")
            fh.write("".join(f"f {a}/{a} {b}/{b} {c}/{c}\n" for a, b, c in NF[Fatlas == k] + 1))
    shutil.rmtree(tmp, ignore_errors=True)

    meta["baked"] = {"obj": f"{out_name}/mesh.obj", "mtl": f"{out_name}/mesh.mtl", "atlases": n_atlas, "atlas_size": ATLAS,
                     "finest_texel_mm": round(hi_t, 3), "mesh": args.mesh}
    (root / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    log(f"done -> {out}")


if __name__ == "__main__":
    main()
