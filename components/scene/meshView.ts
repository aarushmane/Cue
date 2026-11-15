// Renders the view from an aisle point (where no photo was taken): the scan mesh, coloured by projecting the real
// 360° photos onto it. Each photo only paints surfaces its camera actually saw (checked against a depth map rendered
// from that camera), nearer and more head-on photos count more, and surfaces no photo saw are shaded grey.
// WebGL2. Same face convention as detection and the photo viewer (lib/wayfinding/skybox.ts).
import { FACES } from "@/lib/wayfinding/skybox";
import { rotate } from "@/lib/wayfinding/geometry";
import { conjugate, viewBasis, type PanoCamera } from "@/lib/wayfinding/pano";
import type { Quat, Vec3 } from "@/lib/wayfinding/types";

export type PhotoSource = { camera: Vec3; rotation: Quat; faces: HTMLImageElement[] };

const MAX_PHOTOS = 4;
const DEPTH_FACE = 512;
const COLOR_FACE = 1024;
const FAR_M = 40;
/** Texture units used here; the photo viewer uses 0–5. */
const UNIT0 = 6;

type Mat4 = Float32Array;

/** Column-major view-projection for a camera at `eye` with the given axes (fwd looks into the screen). */
function viewProjection(eye: Vec3, right: Vec3, up: Vec3, fwd: Vec3, vfovDeg: number, aspect: number, near = 0.05, far = FAR_M): Mat4 {
  const f = 1 / Math.tan((vfovDeg * Math.PI) / 360);
  const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
  // View rows: right, up, -fwd (OpenGL looks down -z).
  const v = [
    [right.x, right.y, right.z, -dot(right, eye)],
    [up.x, up.y, up.z, -dot(up, eye)],
    [-fwd.x, -fwd.y, -fwd.z, dot(fwd, eye)],
    [0, 0, 0, 1],
  ];
  const p = [
    [f / aspect, 0, 0, 0],
    [0, f, 0, 0],
    [0, 0, (far + near) / (near - far), (2 * far * near) / (near - far)],
    [0, 0, -1, 0],
  ];
  const out = new Float32Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += p[r][k] * v[k][c];
    out[c * 4 + r] = s;
  }
  return out;
}

const g = (v: Vec3) => `vec3(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`;
// Pano-local direction → (face, u, v) with v measured from the top, as in the photo viewer.
const FACE_LOOKUP = `
vec3 faceUv(vec3 l) {
  vec3 a = abs(l);
  float k;
  if (a.z >= a.x && a.z >= a.y) k = l.z > 0.0 ? 0.0 : 5.0;
  else if (a.x >= a.y) k = l.x > 0.0 ? 1.0 : 3.0;
  else k = l.y > 0.0 ? 4.0 : 2.0;
  vec3 f, r, u;
  ${FACES.map((face, i) => `${i ? "else " : ""}if (k == ${i}.0) { f = ${g(face.fwd)}; r = ${g(face.right)}; u = ${g(face.up)}; }`).join("\n  ")}
  float d = dot(l, f);
  return vec3(k, (dot(l, r) / d + 1.0) * 0.5, (1.0 - dot(l, u) / d) * 0.5);
}
vec2 atlas(vec3 f, float inset) {
  vec2 cell = vec2(mod(f.x, 3.0), floor(f.x / 3.0));
  return (cell + clamp(f.yz, inset, 1.0 - inset)) / vec2(3.0, 2.0);
}
vec3 rot(vec4 q, vec3 x) { vec3 t = 2.0 * cross(q.xyz, x); return x + q.w * t + cross(q.xyz, t); }`;

const MESH_VERTEX = `#version 300 es
in vec3 aPos; in vec3 aNormal;
uniform mat4 uVP; uniform float uFlipY;
out vec3 vPos; out vec3 vN;
void main() { vPos = aPos; vN = aNormal; gl_Position = uVP * vec4(aPos, 1.0); gl_Position.y *= uFlipY; }`;

// Distance from the photo camera, packed into two 8-bit channels (0.6 mm steps over 40 m).
const DEPTH_FRAGMENT = `#version 300 es
precision highp float;
in vec3 vPos; in vec3 vN;
uniform vec3 uEye;
out vec4 o;
void main() {
  float d = clamp(length(vPos - uEye) / ${FAR_M.toFixed(1)}, 0.0, 1.0) * 255.0;
  o = vec4(floor(d) / 255.0, fract(d), 0.0, 1.0);
}`;

// Behind the mesh (holes in the scan): the nearest photo, seen from here without parallax.
const BACKDROP_VERTEX = `#version 300 es
in vec2 aPos; out vec2 v;
void main() { v = aPos; gl_Position = vec4(aPos, 0.9999, 1.0); }`;
const BACKDROP_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v;
uniform vec3 uF, uR, uU; uniform float uTx, uTy; uniform vec4 uQ;
uniform sampler2D uColor;
out vec4 o;
${FACE_LOOKUP}
void main() {
  vec3 f = faceUv(rot(uQ, uF + v.x * uTx * uR + v.y * uTy * uU));
  o = vec4(texture(uColor, atlas(f, 0.001)).rgb, 1.0);
}`;

const COLOR_FRAGMENT = `#version 300 es
precision highp float;
in vec3 vPos; in vec3 vN;
uniform int uCount;
uniform vec3 uCam[${MAX_PHOTOS}];
uniform vec4 uQ[${MAX_PHOTOS}];
uniform sampler2D uColor0, uColor1, uColor2, uColor3, uDepth0, uDepth1, uDepth2, uDepth3;
out vec4 o;
${FACE_LOOKUP}
void photo(int i, sampler2D color, sampler2D depth, vec3 n, inout vec3 acc, inout float wsum) {
  if (i >= uCount) return;
  vec3 d = vPos - uCam[i];
  float dist = length(d);
  vec3 f = faceUv(rot(uQ[i], d));
  vec2 stored = texture(depth, atlas(f, 0.002)).rg;
  float seen = (stored.r + stored.g / 255.0) * ${FAR_M.toFixed(1)};
  if (dist > seen + 0.06 + 0.03 * dist) return; // something was in front of this surface from that camera
  float facing = abs(dot(n, d / max(dist, 1e-4)));
  float w = (0.15 + facing) / (dist * dist + 0.25);
  acc += w * texture(color, atlas(f, 0.001)).rgb;
  wsum += w;
}
void main() {
  vec3 n = normalize(vN);
  vec3 acc = vec3(0.0); float wsum = 0.0;
  photo(0, uColor0, uDepth0, n, acc, wsum);
  photo(1, uColor1, uDepth1, n, acc, wsum);
  photo(2, uColor2, uDepth2, n, acc, wsum);
  photo(3, uColor3, uDepth3, n, acc, wsum);
  vec3 grey = vec3(0.62) * (0.7 + 0.3 * abs(n.z));
  o = vec4(wsum > 1e-5 ? acc / wsum : grey, 1.0);
}`;

/**
 * Drop sliver triangles: long and needle-thin, they are reconstruction artefacts around wire racks and other thin
 * structures and show up as shards. What is behind them shows through (the backdrop photo).
 */
export function dropSlivers(tris: Float32Array, maxEdgeM = 0.35, minQuality = 0.08): Float32Array {
  const keep: number[] = [];
  for (let i = 0; i < tris.length; i += 9) {
    const e = (a: number, b: number) => Math.hypot(tris[i + b] - tris[i + a], tris[i + b + 1] - tris[i + a + 1], tris[i + b + 2] - tris[i + a + 2]);
    const l1 = e(0, 3), l2 = e(3, 6), l3 = e(6, 0);
    const longest = Math.max(l1, l2, l3);
    const sp = (l1 + l2 + l3) / 2;
    const area = Math.sqrt(Math.max(0, sp * (sp - l1) * (sp - l2) * (sp - l3)));
    // quality: area relative to an equilateral triangle on the longest edge (1 = equilateral, 0 = needle)
    const quality = longest > 0 ? area / ((Math.sqrt(3) / 4) * longest * longest) : 0;
    if (longest > maxEdgeM && quality < minQuality) continue;
    keep.push(i);
  }
  const out = new Float32Array(keep.length * 9);
  keep.forEach((src, k) => out.set(tris.subarray(src, src + 9), k * 9));
  return out;
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, shader(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, "aPos");
  if (vs.includes("aNormal")) gl.bindAttribLocation(p, 1, "aNormal");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "program");
  return p;
}

export class MeshView {
  private vao: WebGLVertexArrayObject;
  private buffers: WebGLBuffer[] = [];
  private textures: WebGLTexture[] = [];
  private count: number;
  private colorProgram: WebGLProgram;
  private depthProgram: WebGLProgram;
  private backdropProgram: WebGLProgram;
  private quad: WebGLVertexArrayObject;
  private photos: PhotoSource[];

  constructor(private gl: WebGL2RenderingContext, raw: Float32Array, photos: PhotoSource[]) {
    this.photos = photos.slice(0, MAX_PHOTOS);
    const triangles = dropSlivers(raw);
    this.count = triangles.length / 3;
    // Flat normals (the mesh's winding is not guaranteed, so shading uses |n·d|).
    const normals = new Float32Array(triangles.length);
    for (let i = 0; i < triangles.length; i += 9) {
      const e1x = triangles[i + 3] - triangles[i], e1y = triangles[i + 4] - triangles[i + 1], e1z = triangles[i + 5] - triangles[i + 2];
      const e2x = triangles[i + 6] - triangles[i], e2y = triangles[i + 7] - triangles[i + 1], e2z = triangles[i + 8] - triangles[i + 2];
      let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      for (let k = 0; k < 3; k++) { normals[i + k * 3] = nx; normals[i + k * 3 + 1] = ny; normals[i + k * 3 + 2] = nz; }
    }
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    [triangles, normals].forEach((data, loc) => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
      this.buffers.push(b);
    });
    gl.bindVertexArray(null);
    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    const qb = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.buffers.push(qb);
    gl.bindVertexArray(null);
    this.backdropProgram = compile(gl, BACKDROP_VERTEX, BACKDROP_FRAGMENT);
    this.depthProgram = compile(gl, MESH_VERTEX, DEPTH_FRAGMENT);
    this.colorProgram = compile(gl, MESH_VERTEX, COLOR_FRAGMENT);

    this.photos.forEach((photo, i) => {
      this.textures.push(this.colorAtlas(photo, UNIT0 + i));
      this.textures.push(this.depthAtlas(photo, UNIT0 + MAX_PHOTOS + i));
    });
    gl.useProgram(this.colorProgram);
    for (let i = 0; i < MAX_PHOTOS; i++) {
      gl.uniform1i(gl.getUniformLocation(this.colorProgram, `uColor${i}`), UNIT0 + Math.min(i, this.photos.length - 1));
      gl.uniform1i(gl.getUniformLocation(this.colorProgram, `uDepth${i}`), UNIT0 + MAX_PHOTOS + Math.min(i, this.photos.length - 1));
    }
  }

  /** The photo's six faces in a 3×2 atlas (row 0 at the top), so one sampler holds a whole 360°. */
  private colorAtlas(photo: PhotoSource, unit: number) {
    const { gl } = this;
    const canvas = document.createElement("canvas");
    canvas.width = COLOR_FACE * 3;
    canvas.height = COLOR_FACE * 2;
    const ctx = canvas.getContext("2d")!;
    photo.faces.forEach((img, k) => ctx.drawImage(img, (k % 3) * COLOR_FACE, Math.floor(k / 3) * COLOR_FACE, COLOR_FACE, COLOR_FACE));
    const t = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Distance from the photo camera to the first surface, per face pixel, in the same 3×2 layout. */
  private depthAtlas(photo: PhotoSource, unit: number) {
    const { gl } = this;
    const t = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, DEPTH_FACE * 3, DEPTH_FACE * 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    const rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, DEPTH_FACE * 3, DEPTH_FACE * 2);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
    gl.clearColor(1, 1, 0, 1); // nothing hit = as far as can be stored
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(this.depthProgram);
    gl.uniform3f(gl.getUniformLocation(this.depthProgram, "uEye"), photo.camera.x, photo.camera.y, photo.camera.z);
    // Flip y so that row 0 of each cell is the top of the face, matching the colour atlas.
    gl.uniform1f(gl.getUniformLocation(this.depthProgram, "uFlipY"), -1);
    gl.bindVertexArray(this.vao);
    FACES.forEach((face, k) => {
      const fwd = rotate(photo.rotation, face.fwd), right = rotate(photo.rotation, face.right), up = rotate(photo.rotation, face.up);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.depthProgram, "uVP"), false, viewProjection(photo.camera, right, up, fwd, 90, 1));
      gl.viewport((k % 3) * DEPTH_FACE, Math.floor(k / 3) * DEPTH_FACE, DEPTH_FACE, DEPTH_FACE);
      gl.drawArrays(gl.TRIANGLES, 0, this.count);
    });
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteRenderbuffer(rb);
    return t;
  }

  /** Draw the view from `cam` into the current framebuffer (pixel size w × h). */
  render(cam: PanoCamera, pixelW: number, pixelH: number) {
    const { gl } = this;
    const { fwd, right, up } = viewBasis(cam.yawDeg, cam.pitchDeg);
    gl.viewport(0, 0, pixelW, pixelH);
    gl.clearColor(0.85, 0.85, 0.85, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Backdrop: nearest photo.
    let nearest = 0;
    this.photos.forEach((p, i) => {
      const d = (q: Vec3) => Math.hypot(q.x - cam.eye.x, q.y - cam.eye.y, q.z - cam.eye.z);
      if (d(p.camera) < d(this.photos[nearest].camera)) nearest = i;
    });
    const bp = this.backdropProgram;
    const ty = Math.tan((cam.vfovDeg * Math.PI) / 360);
    const nq = conjugate(this.photos[nearest].rotation);
    gl.useProgram(bp);
    gl.uniform3f(gl.getUniformLocation(bp, "uF"), fwd.x, fwd.y, fwd.z);
    gl.uniform3f(gl.getUniformLocation(bp, "uR"), right.x, right.y, right.z);
    gl.uniform3f(gl.getUniformLocation(bp, "uU"), up.x, up.y, up.z);
    gl.uniform1f(gl.getUniformLocation(bp, "uTy"), ty);
    gl.uniform1f(gl.getUniformLocation(bp, "uTx"), ty * (cam.w / cam.h));
    gl.uniform4f(gl.getUniformLocation(bp, "uQ"), nq.x, nq.y, nq.z, nq.w);
    gl.uniform1i(gl.getUniformLocation(bp, "uColor"), UNIT0 + nearest);
    gl.depthMask(false);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.depthMask(true);

    gl.useProgram(this.colorProgram);
    // Near plane at 25 cm: the mesh right in front of the eye is the least accurate part.
    gl.uniformMatrix4fv(gl.getUniformLocation(this.colorProgram, "uVP"), false, viewProjection(cam.eye, right, up, fwd, cam.vfovDeg, cam.w / cam.h, 0.25));
    gl.uniform1f(gl.getUniformLocation(this.colorProgram, "uFlipY"), 1);
    gl.uniform1i(gl.getUniformLocation(this.colorProgram, "uCount"), this.photos.length);
    this.photos.forEach((p, i) => {
      const q = conjugate(p.rotation);
      gl.uniform3f(gl.getUniformLocation(this.colorProgram, `uCam[${i}]`), p.camera.x, p.camera.y, p.camera.z);
      gl.uniform4f(gl.getUniformLocation(this.colorProgram, `uQ[${i}]`), q.x, q.y, q.z, q.w);
    });
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
  }

  dispose() {
    const { gl } = this;
    this.textures.forEach((t) => gl.deleteTexture(t));
    this.buffers.forEach((b) => gl.deleteBuffer(b));
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.colorProgram);
    gl.deleteProgram(this.depthProgram);
    gl.deleteProgram(this.backdropProgram);
    gl.deleteVertexArray(this.quad);
  }
}
