// Pano photos (data/<sid>/panos/, from fetch_panos.py) in the viewer.
//
// buildPanoTextures: no bake yet, so project the photos live. Every pixel of the mesh looks up its world position, finds which panos can see it (a distance
// cube map rendered from each pano position is the occlusion test), and takes its colour from the
// best one: facing it squarely and close by. Where no pano sees the surface, the MatterPak texture
// stays. Nothing is baked: the photos are sampled directly, so detail is whatever the photos have.
// Holes in the mesh are not filled with photos (a photo backdrop looked made-up).
//
// Skybox layout, worked out by matching the photos to the coloured point cloud:
//   local = conjugate(rotation) * (point - position), in Matterport's Z-up frame
//   skybox0 +Z up, skybox1 +X, skybox2 -Y, skybox3 -X, skybox4 +Y, skybox5 -Z down
//   (side faces go clockwise seen from above; image top is +Z on the side faces)
import * as THREE from 'three';

const MAX_PANOS = 7; // per material: 1 texture unit for the fallback + 2 per pano, under the 16-unit limit
const DEPTH_RES = 512;

async function loadFaces(url, res) {
  const data = new Uint8Array(res * res * 4 * 6);
  const ctx = new OffscreenCanvas(res, res).getContext('2d', { willReadFrequently: true });
  await Promise.all([0, 1, 2, 3, 4, 5].map(async (f) => {
    const blob = await fetch(`${url}/skybox${f}.jpg`).then((r) => {
      if (!r.ok) throw new Error(`missing ${url}/skybox${f}.jpg`);
      return r.blob();
    });
    const bmp = await createImageBitmap(blob, { resizeWidth: res, resizeHeight: res, resizeQuality: 'high' });
    return [f, bmp];
  })).then((faces) => {
    for (const [f, bmp] of faces) {
      ctx.drawImage(bmp, 0, 0);
      data.set(ctx.getImageData(0, 0, res, res).data, f * res * res * 4);
      bmp.close();
    }
  });
  const tex = new THREE.DataArrayTexture(data, res, res, 6);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

const distanceMaterial = (origin) => new THREE.ShaderMaterial({
  uniforms: { origin: { value: origin } },
  side: THREE.DoubleSide,
  vertexShader: `varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: `uniform vec3 origin; varying vec3 vW; void main() { gl_FragColor = vec4(length(vW - origin), 0.0, 0.0, 1.0); }`,
});

function renderDistanceCube(renderer, meshObj, origin) {
  const rt = new THREE.WebGLCubeRenderTarget(DEPTH_RES, { type: THREE.HalfFloatType, generateMipmaps: false,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  const cam = new THREE.CubeCamera(0.02, 200, rt);
  cam.position.copy(origin);
  const s = new THREE.Scene();
  s.background = new THREE.Color(1000, 0, 0); // nothing there: everything is "visible" in that direction
  s.overrideMaterial = distanceMaterial(origin);
  const copy = meshObj.clone();
  s.add(copy);
  s.add(cam);
  copy.updateMatrixWorld(true);
  cam.update(renderer, s);
  s.overrideMaterial.dispose();
  return rt.texture;
}

// Direction in a pano's Z-up frame -> (u, v, face). See the layout note at the top of this file.
const CUBE_UV = `
  vec4 cubeUv(vec3 l) {
    vec3 a = abs(l); vec2 uv; float f;
    if (a.z >= a.x && a.z >= a.y) {
      if (l.z > 0.0) { f = 0.0; uv = vec2(-l.y, l.x) / a.z; } else { f = 5.0; uv = vec2(-l.y, -l.x) / a.z; }
    } else if (a.x >= a.y) {
      if (l.x > 0.0) { f = 1.0; uv = vec2(-l.y, -l.z) / a.x; } else { f = 3.0; uv = vec2(l.y, -l.z) / a.x; }
    } else {
      if (l.y > 0.0) { f = 4.0; uv = vec2(l.x, -l.z) / a.y; } else { f = 2.0; uv = vec2(-l.x, -l.z) / a.y; }
    }
    return vec4(uv * 0.5 + 0.5, f, 0.0);
  }`;

function fragmentShader(n, res) {
  let decl = '', body = '';
  for (let i = 0; i < n; i++) {
    decl += `uniform highp sampler2DArray pano${i}; uniform samplerCube dist${i}; uniform vec3 pos${i}; uniform mat3 rot${i};\n`;
    body += `
    {
      vec3 d = vW - pos${i}; float r = length(d); vec3 dir = d / r;
      float seen = step(r, textureCube(dist${i}, dir).r + 0.03 + 0.02 * r);
      vec3 l = rot${i} * dir;
      float w = seen * pow(abs(dot(N, dir)), 1.5) / (r * r) * (l.z < -0.85 ? 0.02 : 1.0);
      vec4 face = cubeUv(l);
      float lod = log2(max(length(dFdx(dir)), length(dFdy(dir))) * ${res / 2}.0 + 1e-6);
      vec3 c = textureLod(pano${i}, face.xyz, max(lod, 0.0)).rgb;
      if (w > best) { best = w; col = c; }
    }`;
  }
  return `
  precision highp sampler2DArray;
  uniform sampler2D map; uniform bool hasMap; uniform vec3 base;
  ${decl}
  varying vec3 vW; varying vec2 vUv;
  ${CUBE_UV}
  void main() {
    vec3 N = normalize(cross(dFdx(vW), dFdy(vW)));
    float best = 0.0; vec3 col = vec3(0.0);
    ${body}
    if (best == 0.0) col = hasMap ? texture2D(map, vUv).rgb : base;
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }`;
}

const vertexShader = `varying vec3 vW; varying vec2 vUv;
  void main() { vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;

/**
 * Load the panos and build pano-textured materials for meshObj.
 * Returns { apply(on), count } or null when the model has no pano photos.
 * zUpToYUp maps a Matterport position to three.js world; res is the face size to use (2048 or 4096).
 */
// Y-up world -> Matterport Z-up: (x, y, z) -> (x, -z, y); then into the pano's own frame.
const yUpToZUp = new THREE.Matrix3().set(1, 0, 0, 0, 0, -1, 0, 1, 0);
function panoFrame(p, zUpToYUp) {
  const q = new THREE.Quaternion(p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w).invert();
  const rot = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q)).multiply(yUpToZUp);
  return { id: p.id, rot, pos: zUpToYUp(p.position), tex: null, dist: null };
}

const loadList = (base) => fetch(base + 'panos/panos.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);

export async function buildPanoTextures({ renderer, meshObj, base, zUpToYUp, res = 2048, onStatus = () => {} }) {
  const list = await loadList(base);
  if (!list?.panos?.length) return null;

  const panos = [];
  for (const [k, p] of list.panos.entries()) {
    onStatus(`Loading pano photos… ${k + 1}/${list.panos.length}`);
    const f = panoFrame(p, zUpToYUp);
    f.tex = await loadFaces(`${base}panos/${p.id}`, res);
    panos.push(f);
  }
  onStatus('Working out what each pano can see…');
  meshObj.updateMatrixWorld(true);
  for (const p of panos) p.dist = renderDistanceCube(renderer, meshObj, p.pos);

  // One pano-textured material per original material, using the panos nearest that part of the mesh.
  const originals = new Map();
  const replaced = new Map();
  const centre = new THREE.Vector3();
  meshObj.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    originals.set(o, o.material);
    const geo = o.geometry;
    const posAttr = geo.attributes.position;
    const groups = geo.groups.length ? geo.groups : [{ start: 0, count: posAttr.count, materialIndex: 0 }];
    const newMats = mats.map((m, mi) => {
      // Rank panos by how many of this material's triangles they are nearest to.
      const votes = new Array(panos.length).fill(0);
      for (const g of groups.filter((gg) => (gg.materialIndex ?? 0) === mi)) {
        for (let v = g.start; v < g.start + g.count; v += 30) {
          centre.fromBufferAttribute(posAttr, v).applyMatrix4(o.matrixWorld);
          let bi = 0, bd = Infinity;
          panos.forEach((p, i) => { const d = p.pos.distanceToSquared(centre); if (d < bd) { bd = d; bi = i; } });
          votes[bi]++;
        }
      }
      const use = panos.map((p, i) => [votes[i], i]).sort((a, b) => b[0] - a[0]).slice(0, MAX_PANOS).map(([, i]) => panos[i]);
      const uniforms = { map: { value: m.map || null }, hasMap: { value: !!m.map }, base: { value: (m.color || new THREE.Color(0x999999)).clone() } };
      use.forEach((p, i) => {
        uniforms[`pano${i}`] = { value: p.tex };
        uniforms[`dist${i}`] = { value: p.dist };
        uniforms[`pos${i}`] = { value: p.pos };
        uniforms[`rot${i}`] = { value: p.rot };
      });
      return new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader: fragmentShader(use.length, res), side: THREE.DoubleSide, glslVersion: null });
    });
    replaced.set(o, Array.isArray(o.material) ? newMats : newMats[0]);
  });

  // Holes are left as holes: the pano backdrop behind them looked made-up, so it is no longer used.
  const apply = (on) => {
    for (const [o, m] of (on ? replaced : originals)) o.material = m;
  };
  return { apply, count: panos.length };
}
