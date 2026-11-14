"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { AlertTriangle, Expand, LoaderCircle, RotateCcw, Shrink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { SceneManifest } from "@/lib/scene/types";

export function SceneViewer({ modelId, name }: { modelId: string; name: string }) {
  const host = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLElement>(null);
  const resetView = useRef(() => {});
  const [message, setMessage] = useState("Loading scene…");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [toolError, setToolError] = useState("");

  useEffect(() => {
    const container = host.current!;
    const abort = new AbortController();
    let dispose = () => {};
    document.addEventListener("fullscreenchange", () => setFullscreen(document.fullscreenElement === viewport.current), { signal: abort.signal });

    async function start() {
      const manifestResponse = await fetch(`/api/scenes/${modelId}`, { signal: abort.signal });
      const manifest = await manifestResponse.json() as SceneManifest & { error?: string };
      if (!manifestResponse.ok) throw new Error(manifest.error || "Could not load the scene.");
      const meshResponse = await fetch(manifest.mesh.url, { signal: abort.signal });
      if (!meshResponse.ok) throw new Error("Could not load this scan's mesh.");
      const source = await meshResponse.text();
      if (abort.signal.aborted) return;

      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      container.appendChild(renderer.domElement);
      const scene = new THREE.Scene();
      const tokens = getComputedStyle(container);
      scene.background = new THREE.Color(tokens.getPropertyValue("--scene-background").trim());
      const model = new OBJLoader().parse(source);
      model.rotation.x = -Math.PI / 2; // API Z-up → viewer Y-up, once.
      const material = new THREE.MeshStandardMaterial({ color: tokens.getPropertyValue("--scene-material").trim(), roughness: 1, side: THREE.DoubleSide });
      model.traverse((node) => {
        if (node instanceof THREE.Mesh) {
          for (const old of Array.isArray(node.material) ? node.material : [node.material]) old.dispose();
          node.material = material;
        }
      });
      scene.add(model, new THREE.HemisphereLight(0xffffff, 0x555555, 2));
      const light = new THREE.DirectionalLight(0xffffff, 2);
      light.position.set(8, 15, 5);
      scene.add(light);

      const bounds = new THREE.Box3().setFromObject(model);
      const center = bounds.getCenter(new THREE.Vector3());
      const camera = new THREE.PerspectiveCamera(70, 1, 0.03, 2000);
      const p = manifest.cameraStart;
      camera.position.copy(p ? new THREE.Vector3(p.x, p.y, p.z) : center);
      // Face the interior. This is an initial view, not a panorama rotation conversion.
      camera.lookAt(center.x, camera.position.y, center.z);

      const canvas = renderer.domElement;
      const startPosition = camera.position.clone();
      const startRotation = camera.quaternion.clone();
      resetView.current = () => {
        camera.position.copy(startPosition);
        camera.quaternion.copy(startRotation);
        canvas.focus();
      };
      canvas.tabIndex = 0;
      canvas.setAttribute("aria-label", `${name} — free-camera 3D mesh. Drag to look; WASD to move; R and F for up and down.`);
      const keys = new Set<string>();
      const options = { signal: abort.signal };
      const moveKeys = ["KeyW", "KeyA", "KeyS", "KeyD", "KeyR", "KeyF"];
      canvas.addEventListener("keydown", (event) => {
        if (moveKeys.includes(event.code)) { event.preventDefault(); keys.add(event.code); }
      }, options);
      canvas.addEventListener("keyup", (event) => keys.delete(event.code), options);
      canvas.addEventListener("blur", () => keys.clear(), options);
      window.addEventListener("blur", () => keys.clear(), options);
      canvas.addEventListener("pointerdown", (event) => {
        canvas.focus();
        canvas.setPointerCapture(event.pointerId);
      }, options);
      const rotation = new THREE.Euler(0, 0, 0, "YXZ");
      canvas.addEventListener("pointermove", (event) => {
        if (!canvas.hasPointerCapture(event.pointerId)) return;
        rotation.setFromQuaternion(camera.quaternion);
        rotation.y -= event.movementX * 0.003;
        rotation.x = THREE.MathUtils.clamp(rotation.x - event.movementY * 0.003, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
        camera.quaternion.setFromEuler(rotation);
      }, options);
      canvas.addEventListener("pointerup", (event) => canvas.releasePointerCapture(event.pointerId), options);

      const resize = new ResizeObserver(() => {
        const { width, height } = container.getBoundingClientRect();
        renderer.setSize(width, height);
        camera.aspect = width / Math.max(height, 1);
        camera.updateProjectionMatrix();
      });
      resize.observe(container);
      const direction = new THREE.Vector3();
      let previous = performance.now();
      renderer.setAnimationLoop((now) => {
        const step = Math.min((now - previous) / 1000, 0.05) * 3;
        previous = now;
        direction.set(Number(keys.has("KeyD")) - Number(keys.has("KeyA")), Number(keys.has("KeyR")) - Number(keys.has("KeyF")), Number(keys.has("KeyS")) - Number(keys.has("KeyW"))).normalize();
        camera.translateX(direction.x * step);
        camera.translateY(direction.y * step);
        camera.translateZ(direction.z * step);
        renderer.render(scene, camera);
      });
      setMessage("");
      setStatus("ready");
      dispose = () => {
        resetView.current = () => {};
        resize.disconnect();
        renderer.setAnimationLoop(null);
        model.traverse((node) => { if (node instanceof THREE.Mesh) node.geometry.dispose(); });
        material.dispose();
        renderer.dispose();
        canvas.remove();
      };
    }

    start().catch((error: unknown) => {
      if (!abort.signal.aborted) {
        setStatus("error");
        setMessage(error instanceof Error ? error.message : "Could not render the scene.");
      }
    });
    return () => { abort.abort(); dispose(); };
  }, [modelId, name, attempt]);

  function retry() {
    setStatus("loading");
    setMessage("Loading scene…");
    setAttempt((value) => value + 1);
  }

  async function toggleFullscreen() {
    setToolError("");
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await viewport.current?.requestFullscreen();
    } catch {
      setToolError("Fullscreen is unavailable in this browser.");
    }
  }

  return (
    <main ref={viewport} className="scene" aria-label={name}>
      <div ref={host} className="scene-canvas" aria-busy={status === "loading"} />
      {status === "loading" && (
        <div className="scene-status" role="status">
          <LoaderCircle className="size-6 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
          <span className="sr-only">{message}</span>
        </div>
      )}
      {status === "error" && (
        <div className="scene-status">
          <Alert variant="destructive" className="pointer-events-auto max-w-sm bg-popover">
            <AlertTriangle aria-hidden="true" />
            <AlertTitle>Scene unavailable</AlertTitle>
            <AlertDescription className="break-words">
              <p>{message}</p>
              <Button variant="outline" size="sm" onClick={retry}><RotateCcw aria-hidden="true" />Retry</Button>
            </AlertDescription>
          </Alert>
        </div>
      )}
      <div className="scene-toolbar flex items-center gap-1 rounded-lg border bg-popover p-1 shadow-sm" role="group" aria-label="Scene tools">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-11" aria-label="Reset view" disabled={status !== "ready"} onClick={() => resetView.current()}>
              <RotateCcw aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Reset view</TooltipContent>
        </Tooltip>
        <Separator orientation="vertical" className="h-6" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-11" aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"} onClick={toggleFullscreen}>
              {fullscreen ? <Shrink aria-hidden="true" /> : <Expand aria-hidden="true" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{fullscreen ? "Exit fullscreen" : "Enter fullscreen"}</TooltipContent>
        </Tooltip>
      </div>
      {toolError && <p role="alert" className="absolute right-4 bottom-4 left-4 m-0 w-fit max-w-sm rounded-md bg-popover p-3 text-body text-destructive">{toolError}</p>}
    </main>
  );
}
