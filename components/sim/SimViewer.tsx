"use client";

import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import * as THREE from "three";
import { livePath } from "@/lib/sim/livePath";
import { decodeGrid, eyeAt, nearestOpen, walk, type SimGrid } from "@/lib/sim/walk";
import { chevronsAlong, floorChevron, ribbon } from "@/lib/wayfinding/pano";
import { edgeIndicator, lookAhead, progressAlong, pointAlong } from "@/lib/wayfinding/screen";
import { FACES } from "@/lib/wayfinding/skybox";
import { FACE_LOOKUP } from "@/lib/wayfinding/skyboxGlsl";
import type { Quat, RoutePlan, Vec3 } from "@/lib/wayfinding/types";

type OkPlan = Extract<RoutePlan, { status: "OK" | "ALREADY_THERE" }>;
type Pano = { id: string; kind: "photo" | "aisle"; label: string | null; position: Vec3; camera: Vec3; rotation: Quat | null };

const MAX_PANOS = 7; // texture units per material: 1 MatterPak map + 2 per photo, under 16
const WALK_MPS = 1.4, RUN_MPS = 3, GUIDE_MPS = 1.2, TURN_DPS = 90;
const MIN_FOV = 35, MAX_FOV = 95;

/** CSS colour (any syntax the browser knows, e.g. oklch tokens) → THREE.Color, via a 1-pixel canvas. */
function cssColor(value: string, fallback: string): THREE.Color {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = fallback;
  ctx.fillStyle = value || fallback;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
}

/** Parse /api/sim/mesh (lib/sim/matterpak.ts) into a geometry with one group per texture. */
function parseMesh(buf: ArrayBuffer): { geometry: THREE.BufferGeometry; textures: (string | null)[] } {
  const headerLen = new Uint32Array(buf, 0, 1)[0];
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headerLen))) as { vertices: number; indices: number; groups: { texture: string | null; start: number; count: number }[] };
  let at = 4 + headerLen;
  const positions = new Float32Array(buf, at, header.vertices * 3); at += positions.byteLength;
  const uvs = new Float32Array(buf, at, header.vertices * 2); at += uvs.byteLength;
  const indices = new Uint32Array(buf, at, header.indices);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  header.groups.forEach((g, i) => geometry.addGroup(g.start, g.count, i));
  return { geometry, textures: header.groups.map((g) => g.texture) };
}

// ── Photo projection: jb_store/viewer/panotex.js (Mann's), ported. Every pixel of the mesh finds which photos can see
// it (a distance cube map rendered from each photo position is the occlusion test) and takes its colour from the best
// one: facing it squarely and close by (weight |n·d|^1.5 / r², straight down — the tripod — ×0.02). Photos are sampled
// at a mip level matched to the pixel's footprint. Where no photo sees the surface, the MatterPak texture stays; holes
// in the mesh stay holes (a photo backdrop looked made-up).
const VERTEX = `varying vec3 vW; varying vec2 vUv;
void main() { vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;

function photoFragment(n: number, res: number) {
  let decl = "", body = "";
  for (let i = 0; i < n; i++) {
    decl += `uniform highp sampler2DArray pano${i}; uniform samplerCube dist${i}; uniform vec3 pos${i}; uniform vec4 q${i};\n`;
    body += `
    {
      vec3 d = vW - pos${i}; float r = length(d); vec3 dir = d / r;
      float seen = step(r, textureCube(dist${i}, dir).r + 0.03 + 0.02 * r);
      vec3 l = rot(q${i}, dir);
      float w = seen * pow(abs(dot(N, dir)), 1.5) / (r * r) * (l.z < -0.85 ? 0.02 : 1.0);
      vec3 f = faceUv(l);
      float lod = log2(max(length(dFdx(dir)), length(dFdy(dir))) * ${res / 2}.0 + 1e-6);
      vec3 c = textureLod(pano${i}, vec3(f.yz, f.x), max(lod, 0.0)).rgb;
      if (w > best) { best = w; col = c; }
    }`;
  }
  return `
  precision highp sampler2DArray;
  uniform sampler2D map; uniform bool hasMap; uniform vec3 base;
  ${decl}
  varying vec3 vW; varying vec2 vUv;
  ${FACE_LOOKUP}
  void main() {
    vec3 N = normalize(cross(dFdx(vW), dFdy(vW)));
    float best = 0.0; vec3 col = vec3(0.0);
    ${body}
    if (best == 0.0) col = hasMap ? texture2D(map, vUv).rgb : base;
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }`;
}

const distanceMaterial = (origin: THREE.Vector3) => new THREE.ShaderMaterial({
  uniforms: { origin: { value: origin } },
  side: THREE.DoubleSide,
  vertexShader: `varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: `uniform vec3 origin; varying vec3 vW; void main() { gl_FragColor = vec4(length(vW - origin), 0.0, 0.0, 1.0); }`,
});

function distanceCube(renderer: THREE.WebGLRenderer, mesh: THREE.Mesh, origin: THREE.Vector3) {
  const rt = new THREE.WebGLCubeRenderTarget(512, { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  const cam = new THREE.CubeCamera(0.02, 100, rt);
  cam.position.copy(origin);
  const s = new THREE.Scene();
  s.background = new THREE.Color(1000, 0, 0); // nothing there: visible in that direction
  s.overrideMaterial = distanceMaterial(origin);
  const copy = mesh.clone();
  s.add(copy, cam);
  copy.updateMatrixWorld(true);
  cam.update(renderer, s);
  s.overrideMaterial.dispose();
  return rt;
}

/** One photo's six faces as a mipmapped texture array (layer = face, row 0 = top), resized to `res`. */
async function panoFaces(modelId: string, pano: Pano, res: number): Promise<THREE.DataArrayTexture> {
  const sky = res > 2048 ? "4k" : "2k";
  const data = new Uint8Array(res * res * 4 * 6);
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(res, res) : Object.assign(document.createElement("canvas"), { width: res, height: res });
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  const faces = await Promise.all(FACES.map(async (_, f) => {
    const r = await fetch(`/api/wayfinding/skybox?${new URLSearchParams({ model_id: modelId, sweep_id: pano.id, face: String(f), res: sky })}`);
    if (!r.ok) throw new Error("photo failed to load");
    return createImageBitmap(await r.blob(), { resizeWidth: res, resizeHeight: res, resizeQuality: "high" });
  }));
  faces.forEach((bmp, f) => {
    ctx.drawImage(bmp, 0, 0);
    data.set(ctx.getImageData(0, 0, res, res).data, f * res * res * 4);
    bmp.close();
  });
  const tex = new THREE.DataArrayTexture(data, res, res, 6);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// ── Route drawn in the scene, lying on the floor ──
function routeGroup(plan: OkPlan, path: Vec3[], color: THREE.Color, ink: THREE.Color): { group: THREE.Group; chevrons: THREE.MeshBasicMaterial[] } {
  const group = new THREE.Group();
  const outline = ribbon(path, 0.16, 0.015);
  if (outline.length >= 4) {
    const k = outline.length / 2;
    const left = outline.slice(0, k), right = outline.slice(k).reverse();
    const pos: number[] = [];
    for (let i = 0; i < k - 1; i++) {
      for (const p of [left[i], right[i], left[i + 1], right[i], right[i + 1], left[i + 1]]) pos.push(p.x, p.y, p.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    group.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 })));
  }
  const chevrons: THREE.MeshBasicMaterial[] = [];
  for (const a of chevronsAlong(path)) {
    const [tip, backL, notch, backR] = floorChevron(a.position, a.headingDeg, 0.24, 0.025);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([tip, backL, notch, tip, notch, backR].flatMap((p) => [p.x, p.y, p.z]), 3));
    const m = new THREE.MeshBasicMaterial({ color: ink, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide });
    chevrons.push(m);
    group.add(new THREE.Mesh(g, m));
  }
  // Where to stand: a ring on the floor.
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.36, 0.43, 64), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide }));
  ring.position.set(plan.standPoint.x, plan.standPoint.y, plan.standPoint.z + 0.02);
  group.add(ring);
  const landing = new THREE.Mesh(new THREE.CircleGeometry(0.43, 64), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }));
  landing.position.set(plan.standPoint.x, plan.standPoint.y, plan.standPoint.z + 0.015);
  group.add(landing);
  // The item: a pin seen through shelves (it marks the goal), on a stem from the floor.
  const item = plan.item.position;
  const marker = document.createElement("canvas");
  marker.width = 384; marker.height = 96;
  const ctx = marker.getContext("2d")!;
  ctx.beginPath(); ctx.roundRect(4, 8, 376, 80, 22);
  ctx.fillStyle = `#${ink.getHexString()}`; ctx.fill();
  ctx.strokeStyle = `#${color.getHexString()}`; ctx.lineWidth = 4; ctx.stroke();
  ctx.beginPath(); ctx.arc(42, 48, 20, 0, Math.PI * 2); ctx.fillStyle = `#${color.getHexString()}`; ctx.fill();
  ctx.beginPath(); ctx.arc(42, 48, 6, 0, Math.PI * 2); ctx.fillStyle = `#${ink.getHexString()}`; ctx.fill();
  ctx.font = `600 30px ${getComputedStyle(document.body).fontFamily}`;
  ctx.textBaseline = "middle"; ctx.fillStyle = `#${color.getHexString()}`;
  let title = plan.item.name;
  while (ctx.measureText(title).width > 285 && title.length > 1) title = title.slice(0, -1);
  if (title !== plan.item.name) title = title.slice(0, -1) + "…";
  ctx.fillText(title, 78, 48);
  const pin = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(marker), depthTest: false, sizeAttenuation: false }));
  pin.scale.set(0.28, 0.07, 1);
  pin.center.set(0.5, 0);
  pin.position.set(item.x, item.y, item.z);
  pin.renderOrder = 10;
  const stem = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(item.x, item.y, plan.standPoint.z), new THREE.Vector3(item.x, item.y, item.z)]),
    new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.8 }),
  );
  stem.renderOrder = 8;
  group.add(stem, pin);
  return { group, chevrons };
}

function disposeGroup(group: THREE.Object3D) {
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => { (x as THREE.SpriteMaterial).map?.dispose(); x.dispose(); });
  });
}

/**
 * Walkable 3D simulation of a store, rendered as in Mann's jb_store viewer: his photo-baked mesh when it exists, else
 * the MatterPak's textured mesh with the scan's real 2k photos projected onto it,
 * walked with WASD (collisions against shelves from the walkable grid), dragged to look, scroll to zoom, number keys
 * to jump to the photo spots. The route is drawn in the scene on the floor (shelves hide it, the item pin shows through).
 */
export function SimViewer({ modelId, plan, onPosition, onUnavailable, controlRef }: {
  modelId: string;
  plan: OkPlan | null;
  /** Floor position, reported when the visitor stops after moving. */
  onPosition: (floor: Vec3) => void;
  onUnavailable: (reason: string) => void;
  controlRef?: import("react").RefObject<import("@/lib/voice/types").ViewControls | null>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const [progress, setProgress] = useState<string | null>("Loading the store…");
  const api = useRef<{ setPlan: (p: OkPlan | null) => void } | null>(null);
  const latest = useRef({ plan, onPosition, onUnavailable });
  useEffect(() => { latest.current = { plan, onPosition, onUnavailable }; api.current?.setPlan(plan); }, [plan, onPosition, onUnavailable]);

  useEffect(() => {
    const root = host.current!, top = overlay.current!;
    let live = true;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    if (!renderer.capabilities.isWebGL2) { onUnavailableOnce("This browser cannot run the 3D walk."); renderer.dispose(); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = "absolute inset-0 size-full outline-none";
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute("role", "application");
    renderer.domElement.setAttribute("aria-label", "3D store. Use W A S D to walk, drag or the arrow keys to look around.");
    root.prepend(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xffffff); // what shows through holes in the mesh (as in Mann's viewer)
    const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 200);
    camera.up.set(0, 0, 1); // Matterport frame: z up, so routes and items need no conversion

    const css = getComputedStyle(root);
    const color = cssColor(css.getPropertyValue("--route-color").trim(), "#fcd44a");
    const ink = cssColor(css.getPropertyValue("--route-ink").trim(), "#ffffff");

    const state = {
      grid: null as SimGrid | null,
      floor: { x: 0, y: 0 },
      yaw: 0, pitch: -8, fov: 75,
      speedMps: 0, guideMps: GUIDE_MPS,
      route: null as { group: THREE.Group; chevrons: THREE.MeshBasicMaterial[] } | null,
      plan: null as OkPlan | null,
      guide: null as null | { path: Vec3[]; atM: number; endYaw: number | null },
      turnTo: null as null | { yaw: number; pitch: number },
      moved: false, lastReport: null as { x: number; y: number } | null, lastReportAt: 0, stillSince: 0,
      drawnAt: null as { x: number; y: number } | null,
      markers: [] as { mesh: THREE.Mesh; pano: Pano }[],
      cubes: [] as THREE.WebGLCubeRenderTarget[],
      materials: null as null | { photo: THREE.Material[]; basic: THREE.Material[] },
      photoOn: new URLSearchParams(window.location.search).get("tex") !== "matterpak",
      mesh: null as THREE.Mesh<THREE.BufferGeometry, THREE.Material[]> | null,
      original: null as THREE.Mesh<THREE.BufferGeometry, THREE.Material[]> | null,
      source: "matterpak" as "baked" | "matterpak",
    };
    const keys = new Set<string>();
    let frame = 0;
    const clock = new THREE.Clock();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    function onUnavailableOnce(reason: string) { if (live) latest.current.onUnavailable(reason); }

    // (Re)draw the route from where the visitor stands: called when a plan arrives and as they move.
    const drawRoute = () => {
      if (state.route) { scene.remove(state.route.group); disposeGroup(state.route.group); state.route = null; }
      const p = state.plan;
      if (!p) return;
      state.route = routeGroup(p, livePath(p.polyline, p.item.position, state.floor, state.grid), color, ink);
      scene.add(state.route.group);
      state.drawnAt = { ...state.floor };
    };
    const setPlan = (p: OkPlan | null) => {
      state.plan = p;
      drawRoute();
    };
    const faceTarget = (t: Vec3, flat = false) => {
      const eye = state.grid ? eyeAt(state.grid, state.floor) : camera.position;
      const d = { x: t.x - eye.x, y: t.y - eye.y, z: t.z - eye.z };
      const pitch = (Math.atan2(d.z, Math.hypot(d.x, d.y)) * 180) / Math.PI;
      state.turnTo = { yaw: (Math.atan2(d.y, d.x) * 180) / Math.PI, pitch: flat ? Math.max(-25, Math.min(-8, pitch)) : pitch };
    };
    const guide = () => {
      const p = state.plan;
      if (!p) return;
      if (p.status === "ALREADY_THERE" || p.polyline.length < 2) { state.guide = null; faceTarget(p.item.position); return; }
      // Walk to where to stand (the ring), not up to the shelf, then turn to the item.
      const path = p.polyline;
      state.guide = { path, atM: progressAlong(path, { ...state.floor, z: 0 }).atM, endYaw: null };
    };
    api.current = { setPlan };
    const stop = () => { state.guide = null; state.turnTo = null; keys.clear(); };
    if (controlRef) controlRef.current = {
      stop,
      turn: (degrees) => { stop(); state.turnTo = { yaw: state.yaw + degrees, pitch: state.pitch }; },
      moving: () => Boolean(state.guide || state.turnTo),
      heading: () => wrap(state.yaw),
      pose: () => state.grid ? { position: { ...state.floor, z: state.grid.floorZ }, headingDeg: wrap(state.yaw), speedMps: state.speedMps, walkingSpeedMps: state.guideMps, moving: Boolean(state.guide || state.turnTo) } : null,
      face: (target) => { stop(); faceTarget(target); },
      speed: (mps) => { state.guideMps = Math.max(0.4, Math.min(1.8, mps)); },
      guide: (plan) => { setPlan(plan); guide(); },
    };

    // A mesh from /api/sim/mesh with its textures, drawn unlit (lighting is already in the photos).
    const loadMesh = async (prefer: "auto" | "matterpak") => {
      const r = await fetch(`/api/sim/mesh?${new URLSearchParams({ model_id: modelId, source: prefer })}`);
      if (!r.ok) throw new Error("This scan has no 3D model to walk in.");
      const source: "baked" | "matterpak" = r.headers.get("x-sim-source") === "baked" ? "baked" : "matterpak";
      const { geometry, textures } = parseMesh(await r.arrayBuffer());
      const loader = new THREE.TextureLoader();
      const maps = textures.map((name) => {
        if (!name) return null;
        const t = loader.load(`/api/sim/texture?${new URLSearchParams({ model_id: modelId, source, name })}`);
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = renderer.capabilities.getMaxAnisotropy();
        return t;
      });
      const basic = maps.map((map) => new THREE.MeshBasicMaterial({ map, color: map ? 0xffffff : 0x999999, side: THREE.DoubleSide }));
      return { source, mesh: new THREE.Mesh<THREE.BufferGeometry, THREE.Material[]>(geometry, basic), maps, basic };
    };

    // Load: mesh, walkable grid and scan points, then the photos.
    (async () => {
      const [first, walkRes, panoRes] = await Promise.all([
        loadMesh("auto"),
        fetch(`/api/sim/walk?model_id=${encodeURIComponent(modelId)}`),
        fetch(`/api/wayfinding/panos?model_id=${encodeURIComponent(modelId)}`),
      ]);
      if (!walkRes.ok || !panoRes.ok) throw new Error("This scan has no 3D model to walk in.");
      const [grid, { sweeps }] = await Promise.all([walkRes.json().then(decodeGrid), panoRes.json() as Promise<{ sweeps: Pano[] }>]);
      if (!live) return;
      state.grid = grid;
      const { mesh, maps, basic } = first;
      scene.add(mesh);
      state.mesh = mesh;
      state.source = first.source;

      // Start on the first photo spot, looking toward the rest of the store.
      const photos = sweeps.filter((s) => s.kind === "photo" && s.rotation);
      const start = photos[0] ?? sweeps[0];
      state.floor = nearestOpen(grid, start ? start.position : { x: grid.minX + (grid.nx * grid.cell) / 2, y: grid.minY + (grid.ny * grid.cell) / 2 });
      const others = photos.slice(1);
      if (others.length) {
        const cx = others.reduce((s, p) => s + p.position.x, 0) / others.length, cy = others.reduce((s, p) => s + p.position.y, 0) / others.length;
        state.yaw = (Math.atan2(cy - state.floor.y, cx - state.floor.x) * 180) / Math.PI;
      }
      state.lastReport = { ...state.floor };
      latest.current.onPosition({ ...state.floor, z: grid.floorZ });

      // Photo spots: rings on the floor (select to go there).
      const ringGeo = new THREE.RingGeometry(0.18, 0.26, 40);
      for (const p of photos) {
        const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }));
        m.position.set(p.position.x, p.position.y, p.position.z + 0.02);
        scene.add(m);
        state.markers.push({ mesh: m, pano: p });
      }
      setPlan(latest.current.plan);
      setProgress(null);

      // Mann's photo-baked mesh already carries the photos: draw it as is (T shows the MatterPak original).
      if (first.source === "baked") { state.materials = { photo: basic, basic }; return; }

      // Otherwise project the photos live (2k faces; ?pano=4k for full size at ~4× the GPU memory).
      const res = new URLSearchParams(window.location.search).get("pano") === "4k" ? 4096 : 2048;
      const use = photos.slice(0, MAX_PANOS);
      if (!use.length) return;
      const panos: THREE.DataArrayTexture[] = [];
      for (const p of use) {
        // One at a time, as in panotex.js, to keep memory down while decoding.
        const tex = await panoFaces(modelId, p, res);
        if (!live) { tex.dispose(); panos.forEach((t) => t.dispose()); return; }
        renderer.initTexture(tex); // upload (and build mipmaps) now; the CPU copy is no longer needed
        (tex.image as unknown as { data: Uint8Array }).data = new Uint8Array(0);
        panos.push(tex);
      }
      mesh.updateMatrixWorld(true);
      const cubes = use.map((p) => distanceCube(renderer, mesh, new THREE.Vector3(p.camera.x, p.camera.y, p.camera.z)));
      state.cubes = cubes;
      const photoMats = maps.map((map, mi) => {
        const uniforms: Record<string, THREE.IUniform> = {
          map: { value: map }, hasMap: { value: Boolean(map) }, base: { value: (basic[mi] as THREE.MeshBasicMaterial).color.clone() },
        };
        use.forEach((p, i) => {
          const q = p.rotation!;
          uniforms[`pano${i}`] = { value: panos[i] };
          uniforms[`dist${i}`] = { value: cubes[i].texture };
          uniforms[`pos${i}`] = { value: new THREE.Vector3(p.camera.x, p.camera.y, p.camera.z) };
          uniforms[`q${i}`] = { value: new THREE.Vector4(-q.x, -q.y, -q.z, q.w) }; // model → pano-local
        });
        return new THREE.ShaderMaterial({ uniforms, vertexShader: VERTEX, fragmentShader: photoFragment(use.length, res), side: THREE.DoubleSide });
      });
      state.materials = { photo: photoMats, basic };
      mesh.material = state.photoOn ? photoMats : basic;
    })().catch((error: unknown) => onUnavailableOnce(error instanceof Error ? error.message : "The 3D walk is unavailable."));

    // ── Input ──
    const abort = new AbortController();
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
    };
    const MOVE_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "ShiftLeft", "ShiftRight"]);
    window.addEventListener("keydown", (e) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (MOVE_KEYS.has(e.code)) {
        keys.add(e.code);
        state.guide = null; state.turnTo = null; // the visitor takes over
        if (e.code.startsWith("Arrow")) e.preventDefault();
      }
      if (e.code === "KeyT" && state.materials && state.mesh) {
        state.photoOn = !state.photoOn;
        if (state.source === "baked") {
          // Mann's baked mesh ↔ the original MatterPak mesh (loaded the first time).
          const swap = async () => {
            if (!state.original) {
              const o = await loadMesh("matterpak");
              if (!live) return;
              state.original = o.mesh;
              scene.add(o.mesh);
            }
            state.mesh!.visible = state.photoOn;
            state.original.visible = !state.photoOn;
          };
          void swap().catch(() => { state.photoOn = true; });
        } else {
          // Photos projected live ↔ the MatterPak's own textures.
          state.mesh.material = state.photoOn ? state.materials.photo : state.materials.basic;
        }
      }
      if (/^Digit[1-9]$/.test(e.code)) {
        const m = state.markers[Number(e.code.slice(5)) - 1];
        if (m) jump(m.pano);
      }
    }, { signal: abort.signal });
    window.addEventListener("keyup", (e) => keys.delete(e.code), { signal: abort.signal });
    window.addEventListener("blur", () => keys.clear(), { signal: abort.signal });

    const jump = (p: Pano) => {
      if (!state.grid) return;
      state.guide = null;
      state.floor = nearestOpen(state.grid, p.position);
      state.moved = true;
      root.animate?.([{ opacity: 0.4 }, { opacity: 1 }], { duration: 250 });
    };

    let drag: { x: number; y: number; moved: number } | null = null;
    const canvas = renderer.domElement;
    canvas.style.cursor = "grab";
    canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, moved: 0 }; canvas.setPointerCapture(e.pointerId); canvas.focus(); state.turnTo = null; }, { signal: abort.signal });
    canvas.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const k = state.fov / canvas.clientHeight;
      state.yaw += (e.clientX - drag.x) * k;
      state.pitch = Math.max(-85, Math.min(85, state.pitch + (e.clientY - drag.y) * k));
      drag.moved += Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y);
      drag.x = e.clientX; drag.y = e.clientY;
      canvas.style.cursor = "grabbing";
    }, { signal: abort.signal });
    canvas.addEventListener("pointerup", (e) => {
      const click = drag && drag.moved < 6;
      drag = null;
      canvas.style.cursor = "grab";
      if (!click) return;
      // Select a photo spot ring to go there.
      const r = canvas.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const hit = ray.intersectObjects(state.markers.map((m) => m.mesh))[0];
      const m = hit && state.markers.find((x) => x.mesh === hit.object);
      if (m) jump(m.pano);
    }, { signal: abort.signal });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      state.fov = Math.max(MIN_FOV, Math.min(MAX_FOV, state.fov * Math.exp(e.deltaY * 0.001)));
    }, { passive: false, signal: abort.signal });

    const resize = () => {
      const w = root.clientWidth, h = root.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      const dpr = Math.min(window.devicePixelRatio, 2);
      top.width = Math.round(w * dpr); top.height = Math.round(h * dpr);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(root);
    resize();

    // ── Frame ──
    const ctx = top.getContext("2d")!;
    const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const dt = Math.min(clock.getDelta(), 0.1);
      const g = state.grid;
      if (!g) { renderer.render(scene, camera); return; }

      // Look keys and smooth turns.
      if (keys.has("ArrowLeft")) state.yaw += TURN_DPS * dt;
      if (keys.has("ArrowRight")) state.yaw -= TURN_DPS * dt;
      if (keys.has("ArrowUp")) state.pitch = Math.min(85, state.pitch + TURN_DPS * 0.6 * dt);
      if (keys.has("ArrowDown")) state.pitch = Math.max(-85, state.pitch - TURN_DPS * 0.6 * dt);
      if (state.turnTo) {
        const k = 1 - Math.exp(-dt * 6);
        state.yaw += wrap(state.turnTo.yaw - state.yaw) * k;
        state.pitch += (state.turnTo.pitch - state.pitch) * k;
        if (Math.abs(wrap(state.turnTo.yaw - state.yaw)) < 0.3 && Math.abs(state.turnTo.pitch - state.pitch) < 0.3) state.turnTo = null;
      }

      // Walk: WASD relative to where you look, on the floor; or follow the route when guided.
      const before = { ...state.floor };
      const yawR = (state.yaw * Math.PI) / 180;
      const fwd = { x: Math.cos(yawR), y: Math.sin(yawR) }, right = { x: Math.sin(yawR), y: -Math.cos(yawR) };
      let mx = 0, my = 0;
      if (keys.has("KeyW")) { mx += fwd.x; my += fwd.y; }
      if (keys.has("KeyS")) { mx -= fwd.x; my -= fwd.y; }
      if (keys.has("KeyD")) { mx += right.x; my += right.y; }
      if (keys.has("KeyA")) { mx -= right.x; my -= right.y; }
      const len = Math.hypot(mx, my);
      if (len > 0) {
        const speed = (keys.has("ShiftLeft") || keys.has("ShiftRight") ? RUN_MPS : WALK_MPS) * dt / len;
        state.floor = walk(g, state.floor, mx * speed, my * speed);
      } else if (state.guide) {
        const gd = state.guide;
        const total = progressAlong(gd.path, gd.path[gd.path.length - 1]).atM;
        const next = pointAlong(gd.path, gd.atM);
        const ahead = pointAlong(gd.path, gd.atM + 0.6);
        let error = 0;
        if (Math.hypot(ahead.x - next.x, ahead.y - next.y) > 0.05) {
          const want = (Math.atan2(ahead.y - next.y, ahead.x - next.x) * 180) / Math.PI;
          error = Math.abs(wrap(want - state.yaw));
          state.yaw += wrap(want - state.yaw) * (1 - Math.exp(-dt * 4));
          state.pitch += (-12 - state.pitch) * (1 - Math.exp(-dt * 3));
        }
        // Align before translating; sharp corners pause walking instead of sliding sideways.
        if (error < 12) {
          gd.atM = Math.min(total, gd.atM + state.guideMps * dt);
          const step = pointAlong(gd.path, gd.atM);
          state.floor = { x: step.x, y: step.y };
        }
        if (gd.atM >= total - 1e-3) { state.guide = null; if (state.plan) faceTarget(state.plan.item.position); }
      }
      const stepped = Math.hypot(state.floor.x - before.x, state.floor.y - before.y) > 1e-4;
      state.speedMps = dt > 0 ? Math.hypot(state.floor.x - before.x, state.floor.y - before.y) / dt : 0;
      if (stepped) { state.moved = true; state.stillSince = performance.now(); }

      // The drawn route follows the visitor every few centimetres: it starts at their feet.
      const now = performance.now();
      if (state.plan && (!state.drawnAt || Math.hypot(state.floor.x - state.drawnAt.x, state.floor.y - state.drawnAt.y) > 0.05)) drawRoute();

      // Tell the page where the visitor is, so it re-plans from there: while walking (every 0.25 s after 0.25 m — a
      // re-plan takes the server ~15 ms), and once more when they stop.
      const last = state.lastReport;
      const since = last ? Math.hypot(state.floor.x - last.x, state.floor.y - last.y) : Infinity;
      const report = () => {
        state.lastReport = { ...state.floor };
        state.lastReportAt = now;
        latest.current.onPosition({ ...state.floor, z: g.floorZ });
      };
      if (stepped && since > 0.25 && now - state.lastReportAt > 250) report();
      else if (state.moved && !stepped && now - state.stillSince > 200) {
        state.moved = false;
        if (since > 0.1) report();
      }

      // Camera.
      const eye = eyeAt(g, state.floor);
      const p = (state.pitch * Math.PI) / 180;
      camera.position.set(eye.x, eye.y, eye.z);
      camera.lookAt(eye.x + Math.cos(p) * fwd.x, eye.y + Math.cos(p) * fwd.y, eye.z + Math.sin(p));
      if (camera.fov !== state.fov) { camera.fov = state.fov; camera.updateProjectionMatrix(); }

      // Quiet when stopped; a subtle forward cue only during guidance.
      if (state.route) {
        const t = now / 1000;
        const animate = Boolean(state.guide) && !reducedMotion.matches;
        state.route.chevrons.forEach((m, i) => { m.opacity = animate ? 0.78 + 0.18 * Math.max(0, Math.sin(t * 2 - i * 0.6)) : 0.95; });
      }
      renderer.render(scene, camera);

      // Edge arrow toward the next stretch of route when it is off screen.
      const w = top.clientWidth, h = top.clientHeight, dpr = top.width / Math.max(1, w);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const plan = state.plan;
      if (plan) {
        const target = plan.status === "ALREADY_THERE" ? plan.item.position : lookAhead(plan.polyline, { ...state.floor, z: g.floorZ }, 2);
        const v = new THREE.Vector3(target.x, target.y, target.z);
        const camSpace = v.clone().applyMatrix4(camera.matrixWorldInverse);
        const behind = camSpace.z > -0.05;
        const ndc = v.clone().project(camera);
        const pt = behind
          ? { x: w / 2 - Math.sign(camSpace.x || 1) * w, y: h / 2, z: 2 }
          : { x: (ndc.x + 1) * 0.5 * w, y: (1 - ndc.y) * 0.5 * h, z: 0 };
        const edge = edgeIndicator(pt, { w, h });
        if (edge) {
          ctx.save();
          ctx.translate(edge.x, edge.y);
          ctx.rotate(edge.angleRad);
          ctx.beginPath(); ctx.moveTo(22, 0); ctx.lineTo(-14, -18); ctx.lineTo(-6, 0); ctx.lineTo(-14, 18); ctx.closePath();
          ctx.fillStyle = `#${color.getHexString()}`; ctx.fill();
          ctx.lineWidth = 2; ctx.strokeStyle = `#${ink.getHexString()}`; ctx.stroke();
          ctx.restore();
        }
      }
    };
    frame = requestAnimationFrame(tick);

    return () => {
      live = false;
      cancelAnimationFrame(frame);
      if (controlRef) controlRef.current = null;
      abort.abort();
      observer.disconnect();
      api.current = null;
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => {
          for (const v of Object.values((x as THREE.ShaderMaterial).uniforms ?? {})) (v.value as THREE.Texture | undefined)?.dispose?.();
          (x as THREE.MeshBasicMaterial).map?.dispose();
          x.dispose();
        });
      });
      state.cubes.forEach((c) => c.dispose());
      for (const m of [...(state.materials?.photo ?? []), ...(state.materials?.basic ?? [])]) m.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [modelId, controlRef]);

  return (
    <div ref={host} className="absolute inset-0">
      <canvas ref={overlay} className="pointer-events-none absolute inset-0 size-full" aria-hidden="true" />
      {progress && (
        <div className="scene-status" role="status">
          <LoaderCircle className="size-6 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
          <span className="sr-only">{progress}</span>
        </div>
      )}
    </div>
  );
}
