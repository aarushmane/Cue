"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Expand, LoaderCircle, RotateCcw, Shrink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { SceneManifest } from "@/lib/scene/types";
import { createEngine } from "./engine";

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
      const meshSource = await meshResponse.text();
      if (abort.signal.aborted) return;
      const tokens = getComputedStyle(container);
      const token = (name: string) => tokens.getPropertyValue(name).trim();
      const engine = createEngine({
        container,
        manifest,
        meshSource,
        label: name,
        signal: abort.signal,
        tokens: { background: token("--scene-background"), material: token("--scene-material"), marker: token("--scene-marker") },
        onReady() {
          resetView.current = () => engine.resetView();
          setMessage("");
          setStatus("ready");
        },
      });
      dispose = () => {
        resetView.current = () => {};
        engine.dispose();
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
