"use client";

import { useEffect, useRef, useState } from "react";
import { Expand, LoaderCircle, RotateCcw, Shrink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";

/**
 * Matterport Showcase embed. Showcase owns navigation: select a floor marker (or use the arrow
 * keys) to jump between scan points, drag to look around. `play=1` starts the tour without the
 * play button and `qs=1` skips the fly-in, so visitors land at the start point.
 */
export function showcaseUrl(modelId: string) {
  return `https://my.matterport.com/show/?${new URLSearchParams({ m: modelId, play: "1", qs: "1" })}`;
}

export function SceneViewer({ modelId, name }: { modelId: string; name: string }) {
  const viewport = useRef<HTMLElement>(null);
  const [status, setStatus] = useState<"loading" | "ready">("loading");
  const [session, setSession] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [toolError, setToolError] = useState("");

  useEffect(() => {
    const abort = new AbortController();
    document.addEventListener("fullscreenchange", () => setFullscreen(document.fullscreenElement === viewport.current), { signal: abort.signal });
    return () => abort.abort();
  }, []);

  // Reloading the embed returns the visitor to the tour's start point.
  function resetView() {
    setStatus("loading");
    setSession((value) => value + 1);
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
      <iframe
        key={session}
        className="scene-embed"
        src={showcaseUrl(modelId)}
        title={`${name} — Matterport 3D tour`}
        allow="fullscreen; xr-spatial-tracking"
        allowFullScreen
        aria-busy={status === "loading"}
        onLoad={() => setStatus("ready")}
      />
      {status === "loading" && (
        <div className="scene-status" role="status">
          <LoaderCircle className="size-6 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
          <span className="sr-only">Loading scene…</span>
        </div>
      )}
      <div className="scene-toolbar flex items-center gap-1 rounded-lg border bg-popover p-1 shadow-sm" role="group" aria-label="Scene tools">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-11" aria-label="Reset view" disabled={status !== "ready"} onClick={resetView}>
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
