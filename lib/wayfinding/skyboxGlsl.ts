// GLSL for sampling a scan point's 360° photo stored as a 3×2 atlas of its six skybox faces (row 0 at the top).
// Generated from the shared face table so detection, the photo viewer and the 3D renderers agree.
import { FACES } from "./skybox";
import type { Vec3 } from "./types";

const g = (v: Vec3) => `vec3(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`;
// Pano-local direction → (face, u, v) with v measured from the top, as in the photo viewer.
export const FACE_LOOKUP = `
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

