// First-person viewer for a Matterport MatterPak mesh downloaded by get_mesh.py.
// Open http://localhost:8000/viewer/?m=<sid> while serving the HackPton folder.
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { buildPanoTextures } from './panotex.js';

const params = new URLSearchParams(location.search);
const sid = params.get('m') || 'UzwrJ9TbQuG';
const panoRes = params.get('pano') === '4k' ? 4096 : 2048; // ?pano=4k: full-size photos, about 4x the GPU memory
const base = `../data/${sid}/`;
const $ = (id) => document.getElementById(id);
const status = (s) => { $('status').textContent = s; };

// Matterport is Z-up; three.js is Y-up. (x, y, z) -> (x, z, -y).
const zUpToYUp = (p) => new THREE.Vector3(p.x, p.z, -p.y);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff); // what shows through holes in the mesh
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 500);
camera.position.set(0, 1.6, 0);
window.viewer = { scene, camera }; // handy for debugging and for the navigation layer later

// Look controls: pointer lock when the browser allows it, otherwise click-and-drag
// (pointer lock is refused in some embedded frames). Both work with a mouse or trackpad.
camera.rotation.order = 'YXZ';
let yaw = 0, pitch = 0, dragging = false, locked = false;
const LOOK = 0.0025;
function look(dx, dy) {
  yaw -= dx * LOOK;
  pitch = Math.max(-1.5, Math.min(1.5, pitch - dy * LOOK));
  camera.rotation.set(pitch, yaw, 0);
}
$('start').addEventListener('click', async () => {
  $('start').classList.add('hidden');
  try { await renderer.domElement.requestPointerLock(); } catch { status('Drag to look around'); }
});
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === renderer.domElement;
});
document.addEventListener('pointerlockerror', () => status('Drag to look around'));
renderer.domElement.addEventListener('mousedown', () => { dragging = true; });
addEventListener('mouseup', () => { dragging = false; });
addEventListener('mousemove', (e) => { if (locked || dragging) look(e.movementX, e.movementY); });

const panoGroup = new THREE.Group();
scene.add(panoGroup);
let panos = [];
let walkHeight = 1.6;
let fly = false;
let meta = null;
let meshObj = null;
let panoTex = null; // pano-photo texturing (panotex.js), on once loaded
let panoOn = true;

// Point cloud (data/<sid>/cloud.bin from get_cloud.py), loaded the first time it is shown.
// Round points sized in metres, so they close up into a surface as you get near.
const cloudGroup = new THREE.Group();
cloudGroup.rotation.x = -Math.PI / 2; // Z-up -> Y-up, same as the mesh
cloudGroup.visible = false;
scene.add(cloudGroup);
const cloudMat = new THREE.ShaderMaterial({
  uniforms: { size: { value: 0.02 }, scale: { value: innerHeight / 2 } },
  vertexShader: `
    uniform float size; uniform float scale;
    attribute vec3 color; varying vec3 vColor;
    void main() {
      vColor = color;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = max(1.0, size * scale / -mv.z);
    }`,
  // Colours are sRGB already and written as is, matching how the mesh textures end up on screen.
  fragmentShader: `
    varying vec3 vColor;
    void main() {
      vec2 c = gl_PointCoord - 0.5;
      if (dot(c, c) > 0.25) discard;
      gl_FragColor = vec4(vColor, 1.0);
    }`,
});
let cloudState = 'none'; // none | loading | ready | missing
const VIEWS = ['Mesh', 'Point cloud', 'Mesh + point cloud'];
let view = 0;

async function loadCloud() {
  const c = meta?.cloud;
  if (!c) { cloudState = 'missing'; status(`No point cloud yet. Run: py -3.13 get_cloud.py ${sid}`); return; }
  cloudState = 'loading';
  const res = await fetch(base + c.file);
  if (!res.ok) { cloudState = 'missing'; status(`Missing data/${sid}/${c.file}. Run: py -3.13 get_cloud.py ${sid}`); return; }
  const total = Number(res.headers.get('content-length')) || c.count * 9;
  const buf = new Uint8Array(total);
  const reader = res.body.getReader();
  for (let got = 0; ;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf.set(value, got);
    got += value.length;
    status(`Loading point cloud… ${Math.round((100 * got) / total)}%`);
  }
  const n = c.count;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Uint16Array(buf.buffer, 0, n * 3), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(buf.buffer, n * 6, n * 3), 3, true));
  const pts = new THREE.Points(geo, cloudMat);
  pts.frustumCulled = false;
  // Dequantise on the GPU: position = min + q * scale.
  pts.scale.fromArray(c.scale);
  pts.position.fromArray(c.min);
  cloudGroup.add(pts);
  cloudState = 'ready';
  showView();
}

function showView() {
  const wantCloud = view > 0;
  if (meshObj) meshObj.visible = view !== 1;
  cloudGroup.visible = wantCloud && cloudState === 'ready';
  if (wantCloud && cloudState === 'none') loadCloud().catch((e) => { cloudState = 'none'; status(e.message); });
  else if (cloudState !== 'loading') {
    const n = meta?.cloud?.count;
    status(`${VIEWS[view]}${wantCloud && n ? ` · ${(n / 1e6).toFixed(1)}M points · point size ${Math.round(cloudMat.uniforms.size.value * 1000)} mm` : ''}`);
  }
}

function goToPano(i) {
  const p = panos[i];
  if (!p) return;
  camera.position.copy(zUpToYUp(p.position));
  walkHeight = camera.position.y;
  status(`At pano ${p.label ?? i}`);
}

// Load an OBJ (+ MTL) from data/<sid>/, unlit since lighting is already in the photo textures.
async function loadMesh(objPath, mtlPath, label) {
  status(`Loading ${label}…`);
  const objLoader = new OBJLoader();
  if (mtlPath) {
    const dir = mtlPath.includes('/') ? mtlPath.slice(0, mtlPath.lastIndexOf('/') + 1) : '';
    const materials = await new MTLLoader().setPath(base + dir).loadAsync(mtlPath.split('/').pop());
    materials.preload();
    objLoader.setMaterials(materials);
  }
  const obj = await objLoader.loadAsync(base + objPath, (e) => {
    if (e.total) status(`Loading ${label}… ${Math.round((100 * e.loaded) / e.total)}%`);
  });
  obj.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const unlit = mats.map((m) => {
      if (m.map) {
        m.map.colorSpace = THREE.SRGBColorSpace;
        m.map.anisotropy = renderer.capabilities.getMaxAnisotropy();
      }
      return new THREE.MeshBasicMaterial({ map: m.map || null, color: m.map ? 0xffffff : (m.color || 0x999999), side: THREE.DoubleSide });
    });
    o.material = Array.isArray(o.material) ? unlit : unlit[0];
  });
  obj.rotation.x = -Math.PI / 2; // Z-up -> Y-up, same mapping as zUpToYUp
  return obj;
}

async function load() {
  meta = await fetch(base + 'meta.json').then((r) => {
    if (!r.ok) throw new Error(`No data/${sid}/meta.json. Run: py -3.13 get_mesh.py ${sid}`);
    return r.json();
  });
  $('title').textContent = meta.name || sid;
  $('addr').textContent = meta.address || '';
  document.title = `${meta.name || sid} · Store Walkthrough`;

  // Prefer the mesh baked from the pano photos (bake_textures.py); T switches to the MatterPak original.
  const baked = meta.baked;
  const obj = baked ? await loadMesh(baked.obj, baked.mtl, 'photo-baked mesh') : await loadMesh(meta.obj, meta.mtl, 'mesh');
  scene.add(obj);
  meshObj = obj;
  if (view === 1) obj.visible = false;

  panos = await fetch(base + 'panos.json').then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const dot = new THREE.SphereGeometry(0.08, 12, 8);
  const mat = new THREE.MeshBasicMaterial({ color: 0x66ccff });
  for (const p of panos) {
    const s = new THREE.Mesh(dot, mat);
    s.position.copy(zUpToYUp(p.position));
    panoGroup.add(s);
  }

  if (baked) {
    let original = null;
    panoTex = {
      async apply(on) {
        if (!on && !original) {
          original = await loadMesh(meta.obj, meta.mtl, 'original mesh');
          scene.add(original);
        }
        const show = on ? obj : original;
        for (const m of [obj, original]) if (m) m.visible = false;
        meshObj = show;
        show.visible = view !== 1;
      },
    };
    status(`Photo-baked textures (${baked.atlases} × ${baked.atlas_size / 1024}k) · T to switch`);
  } else buildPanoTextures({ renderer, meshObj: obj, base, zUpToYUp, res: panoRes, onStatus: status })
    .then((pt) => {
      if (!pt) return;
      panoTex = pt;
      pt.apply(panoOn);
      status(`Photo textures from ${pt.count} panos (${panoRes / 1024}k) · T to switch`);
    })
    .catch((e) => { status(`Pano photos failed: ${e.message}`); console.error(e); });

  if (panos.length) goToPano(0);
  else {
    const b = new THREE.Box3().setFromObject(obj);
    camera.position.set((b.min.x + b.max.x) / 2, b.min.y + 1.6, (b.min.z + b.max.z) / 2);
    walkHeight = camera.position.y;
  }
  if (!panoTex) status(`Loaded · ${panos.length} panos`);
}

// Movement
const keys = new Set();
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'KeyF') { fly = !fly; if (!fly) walkHeight = camera.position.y; status(fly ? 'Fly mode' : 'Walk mode'); }
  if (e.code === 'KeyP') panoGroup.visible = !panoGroup.visible;
  if (e.code === 'KeyT' && panoTex) {
    panoOn = !panoOn;
    panoTex.apply(panoOn);
    status(panoOn ? 'Photo textures (from the panos)' : 'Original MatterPak textures');
  }
  if (e.code === 'KeyM') { view = (view + 1) % VIEWS.length; showView(); }
  if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
    const u = cloudMat.uniforms.size;
    u.value = Math.min(0.06, Math.max(0.002, u.value * (e.code === 'BracketRight' ? 1.25 : 0.8)));
    showView();
  }
  if (/^Digit[1-9]$/.test(e.code)) goToPano(Number(e.code.slice(5)) - 1);
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

const fwd = new THREE.Vector3();
const right = new THREE.Vector3();
const clock = new THREE.Clock();

function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 4 : 1.5) * dt;
  camera.getWorldDirection(fwd);
  if (!fly) { fwd.y = 0; }
  fwd.normalize();
  right.crossVectors(fwd, camera.up).normalize();
  if (keys.has('KeyW')) camera.position.addScaledVector(fwd, speed);
  if (keys.has('KeyS')) camera.position.addScaledVector(fwd, -speed);
  if (keys.has('KeyD')) camera.position.addScaledVector(right, speed);
  if (keys.has('KeyA')) camera.position.addScaledVector(right, -speed);
  if (keys.has('Space')) camera.position.y += speed;
  if (keys.has('KeyC')) camera.position.y -= speed;
  if (!fly && !keys.has('Space') && !keys.has('KeyC')) camera.position.y = walkHeight;
  if (!fly && (keys.has('Space') || keys.has('KeyC'))) walkHeight = camera.position.y;

  const p = camera.position;
  $('pos').textContent = `x ${p.x.toFixed(2)}  y ${(-p.z).toFixed(2)}  z ${p.y.toFixed(2)}  (Matterport frame, m)`;
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  cloudMat.uniforms.scale.value = innerHeight / 2;
});

load().catch((e) => { status(e.message); console.error(e); });
tick();
