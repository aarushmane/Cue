import * as THREE from "three";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { SceneManifest, SkyboxResolution, Sweep } from "@/lib/scene/types";

/**
 * Matterport-style walkthrough renderer.
 *
 * The OBJ from the Model API has no UVs, so instead of a mesh texture we do what Showcase does:
 * each sweep's skybox photo is projected onto the mesh from the sweep's camera centre. Up to
 * SLOTS sweeps are blended per fragment, weighted by how close the viewer is to each sweep and
 * gated by a per-sweep depth cubemap so photos never bleed through walls. Standing on a sweep
 * reproduces its panorama exactly; moving between sweeps cross-fades the projections.
 */

const SLOTS = 4;
const EYE_FALLBACK = 1.35;
const WALK_SPEED = 2.2; // m/s
const TURN_SPEED = 1.6; // rad/s
const MIN_FOV = 30;
const MAX_FOV = 80;
const START_FOV = 70;
const TETHER = 0.3; // m from the sweep graph that free walking may stray
const SETTLE_AFTER = 0.6; // s idle before gliding back onto the nearest sweep
// Skybox face index (Matterport 0 up, 1–4 horizon clockwise, 5 down) for each GL cube slot +X −X +Y −Y +Z −Z.
const CUBE_FACE_ORDER = [2, 4, 0, 5, 1, 3];
// Pano-local (Matterport skybox frame) → GL cube lookup vector: g = (−Ly, Lz, Lx).
const LOCAL_TO_CUBE = new THREE.Matrix3().set(0, -1, 0, 0, 0, 1, 1, 0, 0);
// Viewer (Y-up) → Matterport source (Z-up): (X, Y, Z) → (X, −Z, Y).
const VIEWER_TO_SOURCE = new THREE.Matrix3().set(1, 0, 0, 0, 0, -1, 0, 1, 0);

export type EngineTokens = { background: string; material: string; marker: string };

export type Engine = {
  resetView(): void;
  dispose(): void;
};

type CubeEntry = { texture?: THREE.CubeTexture; failed?: boolean; promise?: Promise<void>; used: number };
type SweepState = {
  sweep: Sweep;
  position: THREE.Vector3;
  floor: THREE.Vector3;
  matrix: THREE.Matrix3;
  cubes: Partial<Record<SkyboxResolution, CubeEntry>>;
  depth?: THREE.WebGLCubeRenderTarget;
  depthUsed: number;
  fade: number;
  puck: THREE.Mesh;
};

const vertexShader = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const slots = Array.from({ length: SLOTS }, (_, i) => i);

const meshFragment = /* glsl */ `
  ${slots.map((i) => `uniform samplerCube uPano${i}; uniform samplerCube uDepth${i};`).join("\n")}
  uniform mat3 uMat[${SLOTS}];
  uniform vec3 uPos[${SLOTS}];
  uniform float uWeight[${SLOTS}];
  uniform float uFloorWeight;
  uniform vec3 uBase;
  uniform vec3 uLight;
  varying vec3 vWorld;
  varying vec3 vNormal;

  void accumulate(samplerCube pano, samplerCube depth, mat3 m, vec3 p, float w, vec3 n,
                  inout vec3 color, inout float total, inout float seen) {
    if (w <= 0.0) return;
    vec3 d = vWorld - p;
    float dist = max(length(d), 1e-4);
    float stored = textureCube(depth, d).r;
    float bias = 0.05 + 0.02 * dist;
    float vis = stored <= 0.0 ? 1.0 : clamp((stored + bias - dist) / bias, 0.0, 1.0);
    float facing = 0.25 + 0.75 * abs(dot(n, d / dist));
    float k = w * vis * facing;
    color += k * textureCube(pano, m * d).rgb;
    total += k;
    seen += w * vis;
  }

  void main() {
    vec3 n = normalize(vNormal);
    vec3 color = vec3(0.0);
    float total = 0.0;
    float seen = 0.0;
    ${slots.map((i) => `accumulate(uPano${i}, uDepth${i}, uMat[${i}], uPos[${i}], uWeight[${i}], n, color, total, seen);`).join("\n    ")}
    vec3 shaded = uBase * (0.45 + 0.55 * abs(dot(n, uLight)));
    float coverage = uFloorWeight > 0.0 ? clamp(seen / uFloorWeight, 0.0, 1.0) : 0.0;
    gl_FragColor = vec4(mix(shaded, color / max(total, 1e-5), coverage), 1.0);
    #include <colorspace_fragment>
  }
`;

const backgroundFragment = /* glsl */ `
  ${slots.map((i) => `uniform samplerCube uPano${i};`).join("\n")}
  uniform mat3 uMat[${SLOTS}];
  uniform float uBackground[${SLOTS}];
  uniform vec3 uClear;
  varying vec3 vWorld;
  void main() {
    vec3 dir = vWorld - cameraPosition;
    vec3 color = vec3(0.0);
    float total = 0.0;
    ${slots.map((i) => `if (uBackground[${i}] > 0.0) { color += uBackground[${i}] * textureCube(uPano${i}, uMat[${i}] * dir).rgb; total += uBackground[${i}]; }`).join("\n    ")}
    gl_FragColor = vec4(total > 0.0 ? color / total : uClear, 1.0);
    #include <colorspace_fragment>
  }
`;

const depthFragment = /* glsl */ `
  uniform vec3 uCenter;
  varying vec3 vWorld;
  void main() { gl_FragColor = vec4(length(vWorld - uCenter)); }
`;

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

function ringTexture(color: string, fill: number, width: number) {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.globalAlpha = fill;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - width, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.95;
  ctx.lineWidth = width;
  ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Drops small disconnected fragments (reconstruction noise that floats in mid-air). */
function withoutDebris(geometry: THREE.BufferGeometry, minTriangles = 150) {
  const position = geometry.getAttribute("position");
  const triangles = position.count / 3;
  const ids = new Map<string, number>();
  const vertex = (i: number) => {
    const key = `${Math.round(position.getX(i) * 1e4)},${Math.round(position.getY(i) * 1e4)},${Math.round(position.getZ(i) * 1e4)}`;
    let id = ids.get(key);
    if (id === undefined) { id = ids.size; ids.set(key, id); }
    return id;
  };
  const corners = Array.from({ length: position.count }, (_, i) => vertex(i));
  const parent = Array.from({ length: ids.size }, (_, i) => i);
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let t = 0; t < triangles; t++) {
    const a = find(corners[3 * t]);
    parent[find(corners[3 * t + 1])] = a;
    parent[find(corners[3 * t + 2])] = a;
  }
  const size = new Map<number, number>();
  for (let t = 0; t < triangles; t++) { const root = find(corners[3 * t]); size.set(root, (size.get(root) ?? 0) + 1); }
  const keep: number[] = [];
  for (let t = 0; t < triangles; t++) if (size.get(find(corners[3 * t]))! >= minTriangles) keep.push(t);
  if (keep.length === triangles || keep.length === 0) return geometry;
  const values = new Float32Array(keep.length * 9);
  keep.forEach((t, k) => { for (let c = 0; c < 3; c++) for (let axis = 0; axis < 3; axis++) values[k * 9 + c * 3 + axis] = position.getComponent(3 * t + c, axis); });
  const result = new THREE.BufferGeometry();
  result.setAttribute("position", new THREE.BufferAttribute(values, 3));
  return result;
}

/** Closest point to `p` on segment ab, in the horizontal plane. */
function closestOnSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, out: THREE.Vector3) {
  const abx = b.x - a.x, abz = b.z - a.z;
  const lengthSq = abx * abx + abz * abz;
  const t = lengthSq > 1e-9 ? THREE.MathUtils.clamp(((p.x - a.x) * abx + (p.z - a.z) * abz) / lengthSq, 0, 1) : 0;
  return out.set(a.x + abx * t, p.y, a.z + abz * t);
}

export function createEngine(options: {
  container: HTMLElement;
  manifest: SceneManifest;
  meshSource: string;
  tokens: EngineTokens;
  label: string;
  signal: AbortSignal;
  /** Resolves once the start sweep's panorama is ready (or failed), so the first frame is final. */
  onReady(): void;
}): Engine {
  const { container, manifest, meshSource, tokens, signal } = options;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 1);
  container.appendChild(renderer.domElement);
  const canvas = renderer.domElement;
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  // ── Geometry ────────────────────────────────────────────────────────────────────────────────
  const parsed = new OBJLoader().parse(meshSource);
  const parts: THREE.BufferGeometry[] = [];
  parsed.traverse((node) => {
    if (node instanceof THREE.Mesh) {
      const geometry = (node.geometry as THREE.BufferGeometry).clone();
      for (const name of Object.keys(geometry.attributes)) if (name !== "position") geometry.deleteAttribute(name);
      parts.push(geometry);
      node.geometry.dispose();
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) material.dispose();
    }
  });
  const merged = parts.length > 1 ? mergeGeometries(parts)! : parts[0] ?? new THREE.BufferGeometry();
  for (const part of parts) if (part !== merged) part.dispose();
  const geometry = withoutDebris(merged);
  if (geometry !== merged) merged.dispose();
  geometry.rotateX(-Math.PI / 2); // Source Z-up → viewer Y-up, baked once.
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const scene = new THREE.Scene();
  const clearColor = new THREE.Color(tokens.background);

  const meshUniforms: Record<string, THREE.IUniform> = {
    uMat: { value: slots.map(() => new THREE.Matrix3()) },
    uPos: { value: slots.map(() => new THREE.Vector3()) },
    uWeight: { value: slots.map(() => 0) },
    uFloorWeight: { value: 0.03 },
    uBase: { value: new THREE.Color(tokens.material) },
    uLight: { value: new THREE.Vector3(0.4, 0.8, 0.45).normalize() },
  };
  const backgroundUniforms: Record<string, THREE.IUniform> = {
    uMat: meshUniforms.uMat,
    uBackground: { value: slots.map(() => 0) },
    uClear: { value: clearColor },
  };
  for (const i of slots) {
    meshUniforms[`uPano${i}`] = { value: null };
    meshUniforms[`uDepth${i}`] = { value: null };
    backgroundUniforms[`uPano${i}`] = meshUniforms[`uPano${i}`];
  }
  const meshMaterial = new THREE.ShaderMaterial({ uniforms: meshUniforms, vertexShader, fragmentShader: meshFragment, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, meshMaterial);
  scene.add(mesh);

  const backgroundMaterial = new THREE.ShaderMaterial({
    uniforms: backgroundUniforms, vertexShader, fragmentShader: backgroundFragment,
    side: THREE.BackSide, depthWrite: false, depthTest: false,
  });
  const background = new THREE.Mesh(new THREE.SphereGeometry(200, 48, 24), backgroundMaterial);
  background.renderOrder = -1;
  background.frustumCulled = false;
  scene.add(background);

  // Depth cubemaps (distance from each sweep centre) are rendered from this private scene.
  const depthMaterial = new THREE.ShaderMaterial({
    uniforms: { uCenter: { value: new THREE.Vector3() } },
    vertexShader, fragmentShader: depthFragment, side: THREE.DoubleSide,
  });
  const depthScene = new THREE.Scene();
  depthScene.add(new THREE.Mesh(geometry, depthMaterial));

  // ── Markers ─────────────────────────────────────────────────────────────────────────────────
  const puckTexture = ringTexture(tokens.marker, 0.22, 9);
  const reticleTexture = ringTexture(tokens.marker, 0.12, 6);
  const puckGeometry = new THREE.PlaneGeometry(0.44, 0.44).rotateX(-Math.PI / 2);
  const markerMaterial = (map: THREE.Texture) => new THREE.MeshBasicMaterial({
    map, transparent: true, depthWrite: false, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  const reticle = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), markerMaterial(reticleTexture));
  reticle.visible = false;
  reticle.renderOrder = 2;
  scene.add(reticle);

  const sweeps: SweepState[] = manifest.sweeps.map((sweep) => {
    const rotation = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(
      new THREE.Quaternion(sweep.rotation.x, sweep.rotation.y, sweep.rotation.z, sweep.rotation.w).normalize(),
    ));
    const matrix = LOCAL_TO_CUBE.clone().multiply(rotation.transpose()).multiply(VIEWER_TO_SOURCE);
    const puck = new THREE.Mesh(puckGeometry, markerMaterial(puckTexture));
    puck.position.set(sweep.position.x, sweep.floorY + 0.03, sweep.position.z);
    puck.renderOrder = 1;
    scene.add(puck);
    return {
      sweep, matrix, puck,
      position: new THREE.Vector3(sweep.position.x, sweep.position.y, sweep.position.z),
      floor: new THREE.Vector3(sweep.position.x, sweep.floorY, sweep.position.z),
      cubes: {}, depthUsed: 0, fade: 0,
    };
  });
  const byId = new Map(sweeps.map((state) => [state.sweep.id, state]));
  const start = (manifest.startSweepId && byId.get(manifest.startSweepId)) || sweeps[0];
  const eyeHeight = start ? start.position.y - start.floor.y : EYE_FALLBACK;

  // Walkable corridor: sweeps plus the straight paths between scan neighbours. Away from it the
  // projected photos have no good source, so free walking stays within TETHER of it.
  const paths: [SweepState, SweepState][] = [];
  for (const state of sweeps) {
    const links = state.sweep.neighbors.map((id) => byId.get(id)).filter((s): s is SweepState => !!s);
    if (!links.length) {
      const nearest = sweeps.filter((s) => s !== state).sort((a, b) => a.position.distanceTo(state.position) - b.position.distanceTo(state.position))[0];
      if (nearest) links.push(nearest);
    }
    for (const other of links) if (!paths.some(([a, b]) => (a === state && b === other) || (a === other && b === state))) paths.push([state, other]);
  }
  const nearPoint = new THREE.Vector3();
  const bestPoint = new THREE.Vector3();
  function tether(position: THREE.Vector3) {
    let best = Infinity;
    const consider = (point: THREE.Vector3) => {
      const d = Math.hypot(point.x - position.x, point.z - position.z);
      if (d < best) { best = d; bestPoint.copy(point); }
    };
    for (const [a, b] of paths) if (Math.abs(a.position.y - position.y) < 1.5) consider(closestOnSegment(position, a.position, b.position, nearPoint));
    for (const state of sweeps) if (Math.abs(state.position.y - position.y) < 1.5) consider(nearPoint.set(state.position.x, position.y, state.position.z));
    if (best <= TETHER || !Number.isFinite(best)) return;
    const k = TETHER / best;
    position.x = bestPoint.x + (position.x - bestPoint.x) * k;
    position.z = bestPoint.z + (position.z - bestPoint.z) * k;
  }

  // ── Camera ──────────────────────────────────────────────────────────────────────────────────
  const bounds = geometry.boundingBox ?? new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  const center = bounds.getCenter(new THREE.Vector3());
  const camera = new THREE.PerspectiveCamera(START_FOV, 1, 0.05, 500);
  camera.position.copy(start ? start.position : center);
  const yaw0 = Math.atan2(-(center.x - camera.position.x), -(center.z - camera.position.z));
  let yaw = Number.isFinite(yaw0) ? yaw0 : 0;
  let pitch = 0;
  const startPose = { position: camera.position.clone(), yaw, pitch, fov: START_FOV };
  const applyRotation = () => camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ"));
  applyRotation();

  // ── Panorama loading ────────────────────────────────────────────────────────────────────────
  const faceUrl = (sweep: Sweep, resolution: SkyboxResolution, face: number) => manifest.skybox.urlTemplate
    .replace("{sweep}", encodeURIComponent(sweep.id))
    .replace("{resolution}", resolution)
    .replace("{face}", String(face));

  let clock = 0;
  function requestCube(state: SweepState, wanted: SkyboxResolution): CubeEntry | undefined {
    const resolution = state.sweep.resolutions.includes(wanted) ? wanted : state.sweep.resolutions[0];
    if (!resolution) return undefined;
    let entry = state.cubes[resolution];
    if (entry) { entry.used = clock; return entry; }
    entry = { used: clock };
    state.cubes[resolution] = entry;
    const target = entry;
    entry.promise = Promise.all(CUBE_FACE_ORDER.map(async (face) => {
      const response = await fetch(faceUrl(state.sweep, resolution, face), { signal });
      if (!response.ok) throw new Error(`Panorama face ${face} failed (${response.status}).`);
      return createImageBitmap(await response.blob());
    })).then((images) => {
      if (signal.aborted) { for (const image of images) image.close(); return; }
      const texture = new THREE.CubeTexture(images as unknown as HTMLImageElement[]);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = anisotropy;
      texture.needsUpdate = true;
      target.texture = texture;
    }).catch((error: unknown) => {
      target.failed = true;
      if (!signal.aborted) console.warn(`Panorama ${state.sweep.id} (${resolution}) unavailable:`, error);
    });
    evict(resolution);
    return entry;
  }

  const limits: Record<SkyboxResolution, number> = { high: 10, "2k": 3 };
  function evict(resolution: SkyboxResolution) {
    const loaded = sweeps.filter((s) => s.cubes[resolution]?.texture && !assigned.includes(s));
    const total = sweeps.filter((s) => s.cubes[resolution]).length;
    loaded.sort((a, b) => a.cubes[resolution]!.used - b.cubes[resolution]!.used);
    for (let excess = total - limits[resolution]; excess > 0 && loaded.length; excess--) {
      const victim = loaded.shift()!;
      victim.cubes[resolution]!.texture!.dispose();
      for (const image of victim.cubes[resolution]!.texture!.images as unknown as ImageBitmap[]) image.close?.();
      delete victim.cubes[resolution];
    }
  }

  const bestCube = (state: SweepState) => state.cubes["2k"]?.texture ?? state.cubes.high?.texture;

  function depthFor(state: SweepState) {
    state.depthUsed = clock;
    if (state.depth) return state.depth.texture;
    const target = new THREE.WebGLCubeRenderTarget(1024, {
      type: THREE.HalfFloatType, format: THREE.RedFormat,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
    });
    const cubeCamera = new THREE.CubeCamera(0.02, 200, target);
    cubeCamera.position.copy(state.position);
    depthMaterial.uniforms.uCenter.value.copy(state.position);
    cubeCamera.update(renderer, depthScene);
    state.depth = target;
    const withDepth = sweeps.filter((s) => s.depth && !assigned.includes(s) && s !== state).sort((a, b) => a.depthUsed - b.depthUsed);
    while (sweeps.filter((s) => s.depth).length > 8 && withDepth.length) {
      const victim = withDepth.shift()!;
      victim.depth!.dispose();
      victim.depth = undefined;
    }
    return target.texture;
  }

  // ── Per-frame sweep blending ────────────────────────────────────────────────────────────────
  let assigned: (SweepState | undefined)[] = slots.map(() => undefined);
  function updateSlots(dt: number) {
    clock++;
    const ranked = [...sweeps].sort((a, b) => a.position.distanceToSquared(camera.position) - b.position.distanceToSquared(camera.position));
    const wanted = ranked.slice(0, SLOTS);
    // Keep sweeps in a stable slot so textures are not rebound every frame.
    const next = assigned.map((state) => (state && wanted.includes(state) ? state : undefined));
    for (const state of wanted) if (!next.includes(state)) next[next.indexOf(undefined)] = state;
    assigned = next;
    for (const state of wanted) requestCube(state, "high");
    // Prefetch where the visitor is likely to go next.
    for (const id of ranked[0]?.sweep.neighbors ?? []) { const neighbor = byId.get(id); if (neighbor) requestCube(neighbor, "high"); }

    let sum = 0;
    const raw = slots.map((i) => {
      const state = assigned[i];
      const texture = state && bestCube(state);
      if (!state || !texture) { if (state) state.fade = 0; return 0; }
      state.fade = reducedMotion ? 1 : Math.min(1, state.fade + dt / 0.18);
      const d = Math.max(state.position.distanceTo(camera.position), 0.02);
      // A steep falloff keeps the nearest photo dominant (no ghosting) and cross-fades only near the midpoint.
      const w = state.fade / d ** 8;
      sum += w;
      return w;
    });
    const floor = meshUniforms.uFloorWeight.value as number;
    for (const i of slots) {
      const state = assigned[i];
      const normalised = sum > 0 ? raw[i] / sum : 0;
      const active = !!state && raw[i] > 0;
      (meshUniforms.uWeight.value as number[])[i] = active ? normalised + floor * state!.fade : 0;
      (backgroundUniforms.uBackground.value as number[])[i] = active ? normalised : 0;
      meshUniforms[`uPano${i}`].value = active ? bestCube(state!) : null;
      meshUniforms[`uDepth${i}`].value = active ? depthFor(state!) : null;
      if (state) {
        (meshUniforms.uMat.value as THREE.Matrix3[])[i].copy(state.matrix);
        (meshUniforms.uPos.value as THREE.Vector3[])[i].copy(state.position);
      }
    }
  }

  // ── Raycasting helpers ──────────────────────────────────────────────────────────────────────
  const raycaster = new THREE.Raycaster();
  const castFrom = (origin: THREE.Vector3, direction: THREE.Vector3, far: number) => {
    raycaster.set(origin, direction);
    raycaster.near = 0;
    raycaster.far = far;
    return raycaster.intersectObject(mesh, false)[0];
  };
  const pointer = new THREE.Vector2();
  const castPointer = (clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    raycaster.near = 0;
    raycaster.far = 200;
    return raycaster.intersectObject(mesh, false)[0];
  };
  const hitNormal = (hit: THREE.Intersection) => {
    const normal = hit.face?.normal.clone() ?? new THREE.Vector3(0, 1, 0);
    if (normal.dot(raycaster.ray.direction) > 0) normal.negate();
    return normal;
  };

  /** The sweep a click at `point` should travel to: nearest on the floor, with a clear line of sight. */
  function sweepFor(point: THREE.Vector3) {
    const candidates = sweeps
      .map((state) => ({ state, score: Math.hypot(state.floor.x - point.x, state.floor.z - point.z) + 2 * Math.abs(state.floor.y - Math.min(point.y, state.floor.y + 0.5)) }))
      .sort((a, b) => a.score - b.score);
    for (const { state } of candidates) {
      const toSweep = state.position.clone().sub(camera.position);
      const distance = toSweep.length();
      if (distance < 0.15) return state; // Already here.
      const blocker = castFrom(camera.position, toSweep.normalize(), distance);
      if (!blocker || blocker.distance > distance - 0.3) return state;
    }
    return candidates[0]?.state;
  }

  // ── Movement ────────────────────────────────────────────────────────────────────────────────
  let transition: { from: THREE.Vector3; to: THREE.Vector3; elapsed: number; duration: number } | null = null;
  function travelTo(state: SweepState) {
    const distance = state.position.distanceTo(camera.position);
    if (distance < 0.05) return;
    velocity.set(0, 0, 0);
    if (reducedMotion) { camera.position.copy(state.position); transition = null; return; }
    transition = { from: camera.position.clone(), to: state.position.clone(), elapsed: 0, duration: THREE.MathUtils.clamp(0.4 + 0.18 * distance, 0.5, 1.1) };
  }

  const keys = new Set<string>();
  const velocity = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const wish = new THREE.Vector3();
  const down = new THREE.Vector3(0, -1, 0);
  const probe = new THREE.Vector3();

  function walk(dt: number) {
    const turn = Number(keys.has("ArrowLeft")) - Number(keys.has("ArrowRight"));
    if (turn) { yaw += turn * TURN_SPEED * dt; applyRotation(); }
    const ahead = Number(keys.has("KeyW") || keys.has("ArrowUp")) - Number(keys.has("KeyS") || keys.has("ArrowDown"));
    const side = Number(keys.has("KeyD")) - Number(keys.has("KeyA"));
    forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    wish.set(0, 0, 0).addScaledVector(forward, ahead).addScaledVector(right, side);
    if (wish.lengthSq() > 0) { wish.normalize().multiplyScalar(WALK_SPEED); transition = null; }
    velocity.lerp(wish, 1 - Math.exp(-12 * dt));
    if (velocity.lengthSq() < 1e-6) { velocity.set(0, 0, 0); return; }

    // Slide along walls and shelving: probe at roughly waist height in the direction of travel.
    const step = velocity.clone().multiplyScalar(dt);
    for (let i = 0; i < 2 && step.lengthSq() > 1e-10; i++) {
      probe.copy(camera.position).y -= eyeHeight * 0.45;
      const length = step.length();
      const hit = castFrom(probe, step.clone().divideScalar(length), length + 0.3);
      if (!hit) break;
      const normal = hitNormal(hit).setY(0);
      if (normal.lengthSq() < 1e-6) break;
      normal.normalize();
      step.addScaledVector(normal, -step.dot(normal));
      velocity.addScaledVector(normal, -velocity.dot(normal));
    }
    camera.position.add(step);
    tether(camera.position);

    // Follow the floor so stairs and ramps keep a constant eye height.
    probe.copy(camera.position).y += 0.3;
    const floorHit = castFrom(probe, down, eyeHeight + 2);
    if (floorHit) camera.position.y += (floorHit.point.y + eyeHeight - camera.position.y) * (1 - Math.exp(-10 * dt));
  }

  // ── Input ───────────────────────────────────────────────────────────────────────────────────
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", `${options.label} — 3D walkthrough. Drag to look around, select a spot on the floor to move there, use W A S D or the arrow keys to walk, and scroll or pinch to zoom.`);
  const listen = { signal };
  const moveKeys = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
  canvas.addEventListener("keydown", (event) => {
    if (moveKeys.has(event.code) && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); keys.add(event.code); }
  }, listen);
  canvas.addEventListener("keyup", (event) => keys.delete(event.code), listen);
  canvas.addEventListener("blur", () => keys.clear(), listen);
  window.addEventListener("blur", () => keys.clear(), listen);

  const pointers = new Map<number, { x: number; y: number }>();
  let gesture: { x: number; y: number; time: number; dragged: boolean; pinch?: number } | null = null;
  let hover: { x: number; y: number } | null = null;

  canvas.addEventListener("pointerdown", (event) => {
    // The default pointerdown action focuses the canvas without forcing a keyboard focus ring.
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) gesture = { x: event.clientX, y: event.clientY, time: performance.now(), dragged: false };
    else if (gesture) { gesture.dragged = true; gesture.pinch = pinchDistance(); }
  }, listen);
  const pinchDistance = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  canvas.addEventListener("pointermove", (event) => {
    hover = event.pointerType === "mouse" ? { x: event.clientX, y: event.clientY } : null;
    const previous = pointers.get(event.pointerId);
    if (!previous || !canvas.hasPointerCapture(event.pointerId)) return;
    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    previous.x = event.clientX;
    previous.y = event.clientY;
    if (!gesture) return;
    if (pointers.size >= 2) {
      const distance = pinchDistance();
      if (gesture.pinch) setFov(camera.fov * (gesture.pinch / Math.max(distance, 1)));
      gesture.pinch = distance;
      return;
    }
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 5) gesture.dragged = true;
    // Grab-the-scene look: the point under the pointer stays under the pointer.
    const radiansPerPixel = THREE.MathUtils.degToRad(camera.fov) / Math.max(canvas.clientHeight, 1);
    yaw += dx * radiansPerPixel;
    pitch = THREE.MathUtils.clamp(pitch + dy * radiansPerPixel, -Math.PI / 2 + 0.05, Math.PI / 2 - 0.05);
    applyRotation();
  }, listen);
  const release = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (pointers.size > 0) return;
    const tap = gesture && !gesture.dragged && performance.now() - gesture.time < 600 && event.type === "pointerup";
    gesture = null;
    if (!tap) return;
    const hit = castPointer(event.clientX, event.clientY);
    if (!hit) return;
    const target = sweepFor(hit.point);
    if (target) travelTo(target);
  };
  canvas.addEventListener("pointerup", release, listen);
  canvas.addEventListener("pointercancel", release, listen);
  canvas.addEventListener("pointerleave", () => { hover = null; }, listen);
  const setFov = (fov: number) => { camera.fov = THREE.MathUtils.clamp(fov, MIN_FOV, MAX_FOV); camera.updateProjectionMatrix(); };
  canvas.addEventListener("wheel", (event) => { event.preventDefault(); setFov(camera.fov * Math.exp(event.deltaY * 0.001)); }, { signal, passive: false });

  // ── Frame loop ──────────────────────────────────────────────────────────────────────────────
  const resize = new ResizeObserver(() => {
    const { width, height } = container.getBoundingClientRect();
    renderer.setSize(width, height);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
  });
  resize.observe(container);

  let resting = 0;
  let idle = 0;
  let previous = performance.now();
  const lookTarget = new THREE.Vector3();
  function frame(now: number) {
    const dt = Math.min((now - previous) / 1000, 0.05);
    previous = now;

    if (transition) {
      transition.elapsed += dt;
      const t = Math.min(transition.elapsed / transition.duration, 1);
      camera.position.lerpVectors(transition.from, transition.to, easeInOut(t));
      if (t >= 1) transition = null;
    }
    walk(dt);
    updateSlots(dt);

    // Upgrade the sweep the visitor is standing on to full resolution once they settle.
    const here = sweeps.find((state) => state.position.distanceTo(camera.position) < 0.15);
    resting = here && !transition && velocity.lengthSq() === 0 ? resting + dt : 0;
    if (here && resting > 0.3) requestCube(here, "2k");

    // Like Showcase, never rest between sweeps: once input stops, glide onto the nearest one so
    // every still frame is an undistorted panorama.
    idle = !here && !transition && !gesture && keys.size === 0 && velocity.lengthSq() === 0 ? idle + dt : 0;
    if (idle > SETTLE_AFTER) {
      idle = 0;
      const nearest = [...sweeps].sort((a, b) => a.position.distanceTo(camera.position) - b.position.distanceTo(camera.position))[0];
      if (nearest) travelTo(nearest);
    }

    // Pucks fade with distance; the one underfoot is hidden.
    const hit = hover && !gesture && !transition ? castPointer(hover.x, hover.y) : undefined;
    const normal = hit && hitNormal(hit);
    const destination = hit && normal!.y > -0.5 ? sweepFor(hit.point) : undefined;
    for (const state of sweeps) {
      const d = state.floor.distanceTo(camera.position);
      const material = state.puck.material as THREE.MeshBasicMaterial;
      material.opacity = state === here ? 0 : state === destination ? 1 : THREE.MathUtils.clamp(1.4 - d / 10, 0, 0.75);
      state.puck.visible = material.opacity > 0.01;
    }
    // Showcase-style surface cursor; hidden on ceilings where a click cannot go anywhere.
    reticle.visible = !!hit && normal!.y > -0.5;
    if (hit && reticle.visible) {
      reticle.position.copy(hit.point).addScaledVector(normal!, 0.01);
      reticle.lookAt(lookTarget.copy(reticle.position).add(normal!));
    }

    background.position.copy(camera.position);
    renderer.render(scene, camera);
  }

  // The first frame waits for the start panorama so the visitor never sees the bare mesh flash.
  const first = start ? requestCube(start, "2k")?.promise ?? Promise.resolve() : Promise.resolve();
  first.then(() => {
    if (signal.aborted) return;
    if (start) start.fade = 1;
    previous = performance.now();
    renderer.setAnimationLoop(frame);
    options.onReady();
  });

  return {
    resetView() {
      transition = null;
      velocity.set(0, 0, 0);
      keys.clear();
      camera.position.copy(startPose.position);
      yaw = startPose.yaw;
      pitch = startPose.pitch;
      applyRotation();
      setFov(startPose.fov);
      canvas.focus();
    },
    dispose() {
      resize.disconnect();
      renderer.setAnimationLoop(null);
      for (const state of sweeps) {
        for (const entry of Object.values(state.cubes)) {
          entry?.texture?.dispose();
          for (const image of (entry?.texture?.images ?? []) as unknown as ImageBitmap[]) image.close?.();
        }
        state.depth?.dispose();
        (state.puck.material as THREE.Material).dispose();
      }
      geometry.dispose();
      puckGeometry.dispose();
      reticle.geometry.dispose();
      (reticle.material as THREE.Material).dispose();
      puckTexture.dispose();
      reticleTexture.dispose();
      background.geometry.dispose();
      for (const material of [meshMaterial, backgroundMaterial, depthMaterial]) material.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}
