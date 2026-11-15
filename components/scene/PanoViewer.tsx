"use client";

import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { FACES } from "@/lib/wayfinding/skybox";
import { chevronsAlong, conjugate, floorChevron, floorPath, floorDisc, lookAtAngles, panoProjector, projectPolygon, ribbon, viewBasis, type PanoCamera } from "@/lib/wayfinding/pano";
import { edgeIndicator, lookAhead } from "@/lib/wayfinding/screen";
import type { Quat, RoutePlan, Vec3 } from "@/lib/wayfinding/types";
import { MeshView } from "./meshView";

type OkPlan = Extract<RoutePlan, { status: "OK" | "ALREADY_THERE" }>;
/** A place to stand: a scan point with a 360° photo, or an aisle point (added from the mesh, shown as a 3D view). */
export type PanoSweep = {
  id: string; kind: "photo" | "aisle"; label: string | null; position: Vec3; camera: Vec3; rotation: Quat | null; neighbors: string[];
};

// Skybox lookup in the fragment shader, generated from the same face table detection uses.
const g = (v: Vec3) => `vec3(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`;
const faceUv = (i: number) => {
  const f = FACES[i];
  return `float f = dot(l, ${g(f.fwd)}); gl_FragColor = texture2D(t${i}, vec2((dot(l, ${g(f.right)}) / f + 1.0) * 0.5, (1.0 - dot(l, ${g(f.up)}) / f) * 0.5));`;
};
const VERTEX = `attribute vec2 p; varying vec2 v; void main() { v = p; gl_Position = vec4(p, 0.0, 1.0); }`;
const FRAGMENT = `precision highp float;
varying vec2 v;
uniform vec3 uF, uR, uU; uniform float uTx, uTy; uniform vec4 uQ;
uniform sampler2D t0, t1, t2, t3, t4, t5;
vec3 rot(vec4 q, vec3 x) { vec3 t = 2.0 * cross(q.xyz, x); return x + q.w * t + cross(q.xyz, t); }
void main() {
  vec3 l = rot(uQ, uF + v.x * uTx * uR + v.y * uTy * uU);
  vec3 a = abs(l);
  if (a.z >= a.x && a.z >= a.y) { if (l.z > 0.0) { ${faceUv(0)} } else { ${faceUv(5)} } }
  else if (a.x >= a.y) { if (l.x > 0.0) { ${faceUv(1)} } else { ${faceUv(3)} } }
  else { if (l.y > 0.0) { ${faceUv(4)} } else { ${faceUv(2)} } }
}`;

function program(gl: WebGLRenderingContext) {
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, shader(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(p, shader(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "program");
  return p;
}

const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error("photo failed to load"));
  img.src = src;
});

const wrap = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;
const MIN_FOV = 35, MAX_FOV = 100;

/**
 * Built-in 360° viewer for scans without a Showcase SDK key. On scan points it shows their photos; on aisle points
 * (where no photo was taken) it draws the scan mesh coloured from those photos. The route is drawn lying on the floor
 * (band, chevrons, destination ring and item pin). Drag to look, scroll to zoom, select a floor marker to move there;
 * markers show the places linked to where you stand.
 */
export function PanoViewer({ modelId, sweepId, plan, faceKey, onSweeps, onMove, onUnavailable, controlRef }: {
  modelId: string;
  sweepId: string | null;
  plan: OkPlan | null;
  /** Changing this turns the camera along the route (or toward the item). */
  faceKey: number;
  onSweeps: (sweeps: PanoSweep[]) => void;
  onMove: (sweepId: string) => void;
  onUnavailable: (reason: string) => void;
  controlRef?: import("react").RefObject<import("@/lib/voice/types").ViewControls | null>;
}) {
  const glCanvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const [sweeps, setSweeps] = useState<PanoSweep[]>([]);
  // Scan point whose photos are on screen; loading until it matches the requested one.
  const [shown, setShown] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const loading = !failed && shown !== sweepId;
  // Mutable view state shared by the render loop and input handlers (no re-render per frame).
  const view = useRef({ yaw: 0, pitch: -12, fov: 75, sweep: null as PanoSweep | null, tween: 0 });
  const redraw = useRef<() => void>(() => {});
  useEffect(() => {
    if (!controlRef) return;
    controlRef.current = {
      stop: () => { view.current.tween++; },
      turn: (degrees) => { view.current.tween++; view.current.yaw = wrap(view.current.yaw + degrees); redraw.current(); },
      moving: () => false,
      heading: () => view.current.yaw,
      pose: () => view.current.sweep ? { position: view.current.sweep.position, headingDeg: view.current.yaw, speedMps: 0, moving: false } : null,
      face: (position) => {
        const v = view.current;
        if (!v.sweep) return;
        v.tween++;
        const aim = lookAtAngles(v.sweep.camera, position);
        v.yaw = aim.yawDeg; v.pitch = aim.pitchDeg; redraw.current();
      },
    };
    return () => { controlRef.current = null; };
  }, [controlRef]);
  const props = useRef({ plan, sweeps, onMove });
  useEffect(() => { props.current = { plan, sweeps, onMove }; redraw.current(); }, [plan, sweeps, onMove]);

  // Scan points.
  useEffect(() => {
    const abort = new AbortController();
    fetch(`/api/wayfinding/panos?model_id=${encodeURIComponent(modelId)}`, { signal: abort.signal })
      .then(async (r) => {
        const data = await r.json().catch(() => ({})) as { sweeps?: PanoSweep[]; error?: string };
        if (!r.ok || !data.sweeps?.length) throw new Error(data.error ?? "This scan has no 360° photos to show.");
        setSweeps(data.sweeps);
        onSweeps(data.sweeps);
      })
      .catch((error: unknown) => { if (!abort.signal.aborted) onUnavailable(error instanceof Error ? error.message : "The 360° view is unavailable."); });
    return () => abort.abort();
  }, [modelId, onSweeps, onUnavailable]);

  // WebGL + overlay renderer, input.
  const images = useRef(new Map<string, Promise<HTMLImageElement[]>>());
  const gpu = useRef<{
    gl: WebGLRenderingContext; gl2: WebGL2RenderingContext | null; prog: WebGLProgram; buffer: WebGLBuffer | null;
    textures: WebGLTexture[]; uniforms: Record<string, WebGLUniformLocation | null>; mesh: MeshView | null;
  } | null>(null);
  const meshReady = useRef<Promise<MeshView> | null>(null);

  useEffect(() => {
    const canvas = glCanvas.current!, top = overlay.current!;
    // WebGL2 when available: aisle views need it. The photo shader runs on either.
    const gl2 = canvas.getContext("webgl2", { antialias: true, preserveDrawingBuffer: false });
    const gl: WebGLRenderingContext | null = gl2 ?? canvas.getContext("webgl", { antialias: false, preserveDrawingBuffer: false });
    if (!gl) { onUnavailable("This browser cannot show the 360° view."); return; }
    let prog: WebGLProgram;
    try { prog = program(gl); } catch { onUnavailable("This browser cannot show the 360° view."); return; }
    gl.useProgram(prog);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const textures = Array.from({ length: 6 }, (_, i) => {
      const t = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(prog, `t${i}`), i);
      return t;
    });
    const uniforms = Object.fromEntries(["uF", "uR", "uU", "uTx", "uTy", "uQ"].map((n) => [n, gl.getUniformLocation(prog, n)]));
    gpu.current = { gl, gl2, prog, buffer, textures, uniforms, mesh: null };

    const ctx = top.getContext("2d")!;
    const css = getComputedStyle(top);
    const color = css.getPropertyValue("--route-color").trim() || "#fcd44a";
    const ink = css.getPropertyValue("--route-ink").trim() || "#ffffff";
    let frame = 0;
    let markers: { id: string; path: Path2D }[] = [];

    const draw = () => {
      frame = 0;
      const v = view.current;
      const dpr = Math.min(window.devicePixelRatio, 2);
      const w = top.clientWidth, h = top.clientHeight;
      for (const c of [canvas, top]) {
        if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!v.sweep || !w || !h) return;

      const cam: PanoCamera = { eye: v.sweep.camera, yawDeg: v.yaw, pitchDeg: v.pitch, vfovDeg: v.fov, w, h };
      const mesh = gpu.current?.mesh;
      if (v.sweep.kind === "aisle" && mesh) mesh.render(cam, canvas.width, canvas.height);
      else if (v.sweep.rotation) {
      // Photo.
      const { fwd, right, up } = viewBasis(v.yaw, v.pitch);
      const ty = Math.tan((v.fov * Math.PI) / 360);
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform3f(uniforms.uF, fwd.x, fwd.y, fwd.z);
      gl.uniform3f(uniforms.uR, right.x, right.y, right.z);
      gl.uniform3f(uniforms.uU, up.x, up.y, up.z);
      gl.uniform1f(uniforms.uTy, ty);
      gl.uniform1f(uniforms.uTx, ty * (w / h));
      const q = conjugate(v.sweep.rotation);
      gl.uniform4f(uniforms.uQ, q.x, q.y, q.z, q.w);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      // Route and markers, lying on the floor.
      const fill = (pts: Vec3[]) => {
        const s = projectPolygon(cam, pts);
        if (s.length < 3) return null;
        const path = new Path2D();
        s.forEach((p, i) => (i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y)));
        path.closePath();
        return path;
      };
      ctx.lineJoin = "round";

      markers = [];
      const linked = new Set(v.sweep.neighbors);
      for (const s of props.current.sweeps) {
        if (s.id === v.sweep.id || !linked.has(s.id)) continue;
        const path = fill(floorDisc(s.position, s.kind === "photo" ? 0.28 : 0.2));
        if (!path) continue;
        ctx.fillStyle = "rgba(255,255,255,0.3)";
        ctx.fill(path);
        ctx.lineWidth = 4;
        ctx.strokeStyle = "rgba(0,0,0,0.35)";
        ctx.stroke(path);
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke(path);
        markers.push({ id: s.id, path });
      }

      const plan = props.current.plan;
      if (plan) {
        const route = floorPath(plan.polyline, plan.item.position);
        const band = route.length > 1 ? fill(ribbon(route, 0.16)) : null;
        if (band) {
          ctx.globalAlpha = 0.3;
          ctx.fillStyle = color;
          ctx.fill(band);
          ctx.globalAlpha = 0.9;
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = ink;
          ctx.stroke(band);
        }
        ctx.globalAlpha = 1;
        for (const a of chevronsAlong(route)) {
          const chevron = fill(floorChevron(a.position, a.headingDeg));
          if (!chevron) continue;
          ctx.fillStyle = ink;
          ctx.fill(chevron);
        }
        const ring = fill(floorDisc(plan.standPoint, 0.4));
        if (ring) { ctx.lineWidth = 4; ctx.strokeStyle = color; ctx.stroke(ring); }

        // Item pin: a stem from the floor up to the item, and a dot on it.
        const project = panoProjector(cam);
        const item = project(plan.item.position);
        const foot = project({ ...plan.item.position, z: plan.standPoint.z });
        if (item.z === 0) {
          if (foot.z === 0) {
            ctx.beginPath(); ctx.moveTo(foot.x, foot.y); ctx.lineTo(item.x, item.y);
            ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.stroke();
          }
          ctx.beginPath(); ctx.arc(item.x, item.y, 10, 0, Math.PI * 2);
          ctx.fillStyle = color; ctx.fill();
          ctx.lineWidth = 3; ctx.strokeStyle = ink; ctx.stroke();
        }

        // Which way to turn when the next stretch is off screen.
        const target = plan.status === "ALREADY_THERE" ? plan.item.position : lookAhead(plan.polyline, v.sweep.position, 2);
        const edge = edgeIndicator(project(target), { w, h });
        if (edge) {
          ctx.save();
          ctx.translate(edge.x, edge.y);
          ctx.rotate(edge.angleRad);
          ctx.beginPath(); ctx.moveTo(22, 0); ctx.lineTo(-14, -18); ctx.lineTo(-6, 0); ctx.lineTo(-14, 18); ctx.closePath();
          ctx.fillStyle = color; ctx.fill();
          ctx.lineWidth = 2; ctx.strokeStyle = ink; ctx.stroke();
          ctx.restore();
        }
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };
    redraw.current = schedule;

    // Input: drag to look, click a floor marker to move, wheel to zoom, arrow keys to turn.
    let drag: { x: number; y: number; moved: number } | null = null;
    const hit = (e: PointerEvent) => {
      const r = top.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio, 2);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return markers.find((m) => ctx.isPointInPath(m.path, (e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr))?.id;
    };
    const abort = new AbortController();
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) =>
      top.addEventListener(type, fn, { signal: abort.signal, ...opts });
    on("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, moved: 0 }; top.setPointerCapture(e.pointerId); view.current.tween++; });
    on("pointermove", (e) => {
      if (!drag) { top.style.cursor = hit(e) ? "pointer" : "grab"; return; }
      const v = view.current, k = v.fov / top.clientHeight;
      v.yaw = wrap(v.yaw + (e.clientX - drag.x) * k);
      v.pitch = Math.max(-85, Math.min(85, v.pitch + (e.clientY - drag.y) * k));
      drag.moved += Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y);
      drag.x = e.clientX; drag.y = e.clientY;
      top.style.cursor = "grabbing";
      schedule();
    });
    on("pointerup", (e) => {
      const moved = drag?.moved ?? 0;
      drag = null;
      top.style.cursor = "grab";
      if (moved < 6) { const id = hit(e); if (id) props.current.onMove(id); }
    });
    on("pointercancel", () => { drag = null; });
    on("wheel", (e) => {
      e.preventDefault();
      const v = view.current;
      v.fov = Math.max(MIN_FOV, Math.min(MAX_FOV, v.fov * Math.exp(e.deltaY * 0.001)));
      schedule();
    }, { passive: false });
    on("keydown", (e) => {
      const v = view.current;
      const step = { ArrowLeft: [5, 0], ArrowRight: [-5, 0], ArrowUp: [0, 5], ArrowDown: [0, -5] }[e.key];
      if (!step) return;
      e.preventDefault();
      v.tween++;
      v.yaw = wrap(v.yaw + step[0]);
      v.pitch = Math.max(-85, Math.min(85, v.pitch + step[1]));
      schedule();
    });
    const resize = new ResizeObserver(schedule);
    resize.observe(top);
    return () => {
      abort.abort(); resize.disconnect(); cancelAnimationFrame(frame);
      redraw.current = () => {};
      gpu.current?.mesh?.dispose();
      gpu.current = null;
      meshReady.current = null;
      textures.forEach((t) => gl.deleteTexture(t));
      gl.deleteBuffer(buffer);
      gl.deleteProgram(prog);
    };
  }, [onUnavailable]);

  // Move: a scan point needs its six photos; an aisle point needs the mesh and every scan point's photos.
  useEffect(() => {
    const target = sweeps.find((s) => s.id === sweepId) ?? null;
    if (!target) return;
    let live = true;
    const faces = (s: PanoSweep) => {
      let p = images.current.get(s.id);
      if (!p) {
        p = Promise.all(FACES.map((_, i) => loadImage(`/api/wayfinding/skybox?${new URLSearchParams({ model_id: modelId, sweep_id: s.id, face: String(i) })}`)));
        images.current.set(s.id, p);
        p.catch(() => images.current.delete(s.id));
      }
      return p;
    };
    const photos = sweeps.filter((s) => s.kind === "photo" && s.rotation);
    const meshView = () => {
      const g = gpu.current;
      if (!g?.gl2) return Promise.reject(new Error("This browser cannot draw aisle views."));
      if (!meshReady.current) {
        const gl2 = g.gl2;
        meshReady.current = Promise.all([
          fetch(`/api/wayfinding/mesh?model_id=${encodeURIComponent(modelId)}`).then(async (r) => {
            if (!r.ok) throw new Error("The 3D scan could not be loaded.");
            return new Float32Array(await r.arrayBuffer());
          }),
          Promise.all(photos.map(faces)),
        ]).then(([triangles, imgs]) => {
          const view = new MeshView(gl2, triangles, photos.map((s, i) => ({ camera: s.camera, rotation: s.rotation!, faces: imgs[i] })));
          if (gpu.current) gpu.current.mesh = view;
          return view;
        });
        meshReady.current.catch(() => { meshReady.current = null; });
      }
      return meshReady.current;
    };
    const ready: Promise<unknown> = target.kind === "aisle"
      ? meshView()
      : faces(target).then((imgs) => {
        const g = gpu.current;
        if (!live || !g) return;
        imgs.forEach((img, i) => {
          g.gl.activeTexture(g.gl.TEXTURE0 + i);
          g.gl.bindTexture(g.gl.TEXTURE_2D, g.textures[i]);
          g.gl.texImage2D(g.gl.TEXTURE_2D, 0, g.gl.RGB, g.gl.RGB, g.gl.UNSIGNED_BYTE, img);
        });
      });
    ready.then(() => {
      if (!live || !gpu.current) return;
      view.current.sweep = target;
      setShown(target.id);
      redraw.current();
      // Warm the rest so moving is instant.
      for (const s of photos) faces(s).catch(() => {});
      if (gpu.current.gl2) meshView().catch(() => {});
    }).catch((error: unknown) => {
      if (!live) return;
      if (target.kind === "aisle") {
        // Stay where we are; aisle views are an extra.
        console.warn("aisle view unavailable", error);
        if (view.current.sweep) props.current.onMove(view.current.sweep.id);
        return;
      }
      setFailed(true);
      onUnavailable("The 360° photos could not be loaded.");
    });
    return () => { live = false; };
  }, [sweepId, sweeps, modelId, onUnavailable]);

  // Turn along the route when a route arrives (it is planned from where the visitor stands) or when asked.
  useEffect(() => {
    const v = view.current;
    const here = sweeps.find((s) => s.id === sweepId);
    if (!plan || !here || loading) return;
    const target = plan.status === "ALREADY_THERE" ? plan.item.position : lookAhead(plan.polyline, here.position, 3);
    const aim = lookAtAngles(here.camera, target);
    const goal = { yaw: aim.yawDeg, pitch: plan.status === "ALREADY_THERE" ? aim.pitchDeg : Math.max(-25, Math.min(-12, aim.pitchDeg)) };
    const from = { yaw: v.yaw, pitch: v.pitch };
    const dYaw = wrap(goal.yaw - from.yaw);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const token = ++v.tween;
    const start = performance.now();
    const step = (now: number) => {
      if (v.tween !== token) return; // the visitor took over
      const t = reduce ? 1 : Math.min(1, (now - start) / 700);
      const e = 1 - Math.pow(1 - t, 3);
      v.yaw = wrap(from.yaw + dYaw * e);
      v.pitch = from.pitch + (goal.pitch - from.pitch) * e;
      redraw.current();
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, [plan, faceKey, sweepId, sweeps, loading]);

  return (
    <>
      <canvas ref={glCanvas} className="absolute inset-0 size-full" aria-hidden="true" />
      <canvas
        ref={overlay}
        className="absolute inset-0 size-full touch-none outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        style={{ cursor: "grab" }}
        tabIndex={0}
        role="img"
        aria-label="360° view of the store. Drag or use the arrow keys to look around."
      />
      {loading && (
        <div className="scene-status" role="status">
          <LoaderCircle className="size-6 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
          <span className="sr-only">Loading 360° photos…</span>
        </div>
      )}
    </>
  );
}
