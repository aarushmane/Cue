"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { MpSdk } from "@matterport/sdk";
import { ChevronDown, ChevronUp, Crosshair, Expand, Footprints, LoaderCircle, RotateCcw, Search, Shrink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { lookAhead } from "@/lib/wayfinding/screen";
import { RouteMap } from "./RouteMap";
import { PanoViewer, type PanoSweep } from "./PanoViewer";
import { SimViewer } from "@/components/sim/SimViewer";
import type { Vec3 } from "@/lib/wayfinding/types";
import { RouteOverlay } from "./RouteOverlay";
import { connectShowcase, SDK_KEY, stepAlong, toApi, watchSweeps, type ClientWaypoint, type Pose } from "./showcase";
import { useWayfinding } from "./useWayfinding";

/**
 * Matterport Showcase embed. Showcase owns navigation: select a floor marker (or use the arrow keys) to jump between
 * scan points, drag to look around. `play=1` starts the tour without the play button and `qs=1` skips the fly-in.
 * With NEXT_PUBLIC_MATTERPORT_SDK_KEY set, the SDK reports the camera so routes are drawn inside the 3D view.
 * Without a key, the walkable 3D simulation (SimViewer: the scan's textured mesh with its photos projected on, WASD
 * to walk) replaces the embed, with the route drawn on the floor. If it can't run, the 360° photo viewer (PanoViewer)
 * takes over, and failing that the plain embed.
 */
export function showcaseUrl(modelId: string) {
  return `https://my.matterport.com/show/?${new URLSearchParams({ m: modelId, play: "1", qs: "1", ...(SDK_KEY ? { applicationKey: SDK_KEY } : {}) })}`;
}

function ToolButton({ label, onClick, disabled, children }: { label: string; onClick?: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="size-11" aria-label={label} disabled={disabled} onClick={onClick}>{children}</Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export function SceneViewer({ modelId, name }: { modelId: string; name: string }) {
  const viewport = useRef<HTMLElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const pose = useRef<Pose | null>(null);
  const [status, setStatus] = useState<"loading" | "ready">("loading");
  const [session, setSession] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [toolError, setToolError] = useState("");
  const [sdk, setSdk] = useState<MpSdk | null>(null);
  const [query, setQuery] = useState("");
  const [stepping, setStepping] = useState(false);
  // The route panel folds down to one line so it doesn't cover the tour.
  const [folded, setFolded] = useState(false);
  // Walkable simulation (no SDK key): where the visitor stands, and a counter that starts "walk me there".
  const [simFailed, setSimFailed] = useState(false);
  const sim = !SDK_KEY && !simFailed;
  const simFloor = useRef<Vec3 | null>(null);
  const [guideKey, setGuideKey] = useState(0);
  // Built-in 360° viewer (fallback): which scan point the visitor stands on.
  const [panoFailed, setPanoFailed] = useState(false);
  const pano = !SDK_KEY && simFailed && !panoFailed;
  const [sweepId, setSweepId] = useState<string | null>(null);
  const firstSweep = useRef<string | null>(null);
  const [faceKey, setFaceKey] = useState(0);

  const sweeps = useRef<ClientWaypoint[]>([]);
  const context = useCallback(() => {
    if (sim) return { start: simFloor.current ? { position: simFloor.current } : {} };
    if (pano) return { start: sweepId ? { sweep_id: sweepId } : {} };
    const current = pose.current;
    if (!sdk || !current) return { start: {} };
    return {
      start: { sweep_id: current.sweep || undefined, position: toApi(sdk, current.position) },
      waypoints: sweeps.current.length ? sweeps.current : undefined,
    };
  }, [sdk, sim, pano, sweepId]);
  const wayfinding = useWayfinding(modelId, context);
  const { reroute } = wayfinding;

  const onSweeps = useCallback((list: PanoSweep[]) => {
    firstSweep.current = list[0].id;
    // `?at=<point id>` opens the view at that place (shareable).
    const at = new URLSearchParams(window.location.search).get("at");
    const start = list.find((s) => s.id === at)?.id ?? list[0].id;
    setSweepId((current) => current ?? start);
  }, []);
  const onUnavailable = useCallback((reason: string) => {
    console.warn("360° viewer unavailable, using the Matterport tour:", reason);
    setPanoFailed(true);
  }, []);
  const onSimPosition = useCallback((floor: Vec3) => {
    simFloor.current = floor;
    void reroute({ position: floor }); // walking re-plans the route from where the visitor stopped
  }, [reroute]);
  const onSimUnavailable = useCallback((reason: string) => {
    console.warn("3D walk unavailable, using the 360° photos:", reason);
    setSimFailed(true);
  }, []);
  // Moving re-plans the route from the new scan point.
  useEffect(() => { if (pano && sweepId) void reroute({ sweep_id: sweepId }); }, [pano, sweepId, reroute]);
  const plan = wayfinding.state.status === "ready" && (wayfinding.state.plan?.status === "OK" || wayfinding.state.plan?.status === "ALREADY_THERE")
    ? wayfinding.state.plan : null;

  useEffect(() => {
    const abort = new AbortController();
    document.addEventListener("fullscreenchange", () => setFullscreen(document.fullscreenElement === viewport.current), { signal: abort.signal });
    return () => abort.abort();
  }, []);

  // Connect the SDK once the tour has loaded (only when a key is configured).
  useEffect(() => {
    if (!SDK_KEY || status !== "ready" || !frame.current) return;
    let live = true;
    let cancel = () => {};
    connectShowcase(frame.current).then((connected) => {
      if (!live) return connected.disconnect();
      const sub = connected.Camera.pose.subscribe((next) => { pose.current = next; });
      const sweepSub = watchSweeps(connected, (next) => { sweeps.current = next; });
      cancel = () => { sub.cancel(); sweepSub.cancel(); connected.disconnect(); };
      setSdk(connected);
    }).catch((error: unknown) => {
      if (live) setToolError(error instanceof Error ? error.message.split("\n")[0] : "The 3D route overlay is unavailable.");
    });
    return () => { live = false; cancel(); setSdk(null); };
  }, [status, session]);

  // Reloading the embed returns the visitor to the tour's start point.
  function resetView() {
    if (sim || pano) { setSweepId(firstSweep.current); setSession((value) => value + 1); return; }
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

  function submit(event: FormEvent) {
    event.preventDefault();
    if (query.trim()) { setFolded(false); wayfinding.find(query.trim()); }
  }

  async function nextStop() {
    if (sim && plan) { setGuideKey((k) => k + 1); return; }
    if (pano && plan) {
      const ids = plan.waypointIds;
      const at = sweepId ? ids.indexOf(sweepId) : -1;
      if (at >= 0 && at < ids.length - 1) setSweepId(ids[at + 1]);
      else if (at === -1 && ids.length) setSweepId(ids[0]);
      else setFaceKey((k) => k + 1);
      return;
    }
    if (!sdk || !plan || !pose.current) return;
    setStepping(true);
    try {
      const ids = plan.waypointIds;
      // After each move, face 2.5 m further along the route from where Showcase put us; at the last stop, the item.
      await stepAlong(sdk, ids, pose.current.sweep, (i) =>
        i >= ids.length - 1 || !pose.current ? plan.item.position : lookAhead(plan.polyline, toApi(sdk, pose.current.position), 2.5));
    } catch {
      setToolError("Could not move to the next stop.");
    } finally {
      setStepping(false);
    }
  }

  const s = wayfinding.state;
  return (
    <main ref={viewport} className="scene" aria-label={name}>
      {sim ? (
        <SimViewer key={session} modelId={modelId} plan={plan} guideKey={guideKey} onPosition={onSimPosition} onUnavailable={onSimUnavailable} />
      ) : pano ? (
        <PanoViewer
          key={session}
          modelId={modelId}
          sweepId={sweepId}
          plan={plan}
          faceKey={faceKey}
          onSweeps={onSweeps}
          onMove={setSweepId}
          onUnavailable={onUnavailable}
        />
      ) : <iframe
        ref={frame}
        key={session}
        className="scene-embed"
        src={showcaseUrl(modelId)}
        title={`${name} — Matterport 3D tour`}
        allow="fullscreen; xr-spatial-tracking"
        allowFullScreen
        aria-busy={status === "loading"}
        onLoad={() => setStatus("ready")}
      />}
      {sdk && plan && <RouteOverlay sdk={sdk} plan={plan} />}
      {!pano && !sim && status === "loading" && (
        <div className="scene-status" role="status">
          <LoaderCircle className="size-6 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
          <span className="sr-only">Loading scene…</span>
        </div>
      )}
      <div className="scene-toolbar flex max-w-[calc(100vw-2rem)] flex-col items-end gap-2">
        <div className="flex items-center gap-1 rounded-lg border bg-popover p-1 shadow-sm" role="group" aria-label="Scene tools">
          <form onSubmit={submit} className="flex min-w-0 items-center gap-1" role="search">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find an item"
              aria-label="Find an item"
              className="h-11 w-36 sm:w-56"
              maxLength={300}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="submit" variant="ghost" size="icon" className="size-11" aria-label="Find" disabled={!query.trim() || s.status === "loading"}>
                  {s.status === "loading" ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Search aria-hidden="true" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Find</TooltipContent>
            </Tooltip>
          </form>
          <Separator orientation="vertical" className="h-6" />
          <ToolButton label="Reset view" disabled={!pano && !sim && status !== "ready"} onClick={resetView}><RotateCcw aria-hidden="true" /></ToolButton>
          <Separator orientation="vertical" className="h-6" />
          <ToolButton label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"} onClick={toggleFullscreen}>
            {fullscreen ? <Shrink aria-hidden="true" /> : <Expand aria-hidden="true" />}
          </ToolButton>
        </div>

        {s.status !== "idle" && s.status !== "loading" && (
          <section className="w-80 max-w-full rounded-lg border bg-popover p-3 text-popover-foreground shadow-sm" aria-live="polite" aria-label="Route">
            <div className="flex items-start justify-between gap-2">
              <h2 className="m-0 min-w-0 text-heading break-words">
                {s.status === "ready" && s.item ? s.item.name : s.status === "choose" ? "Which one?" : "No route"}
              </h2>
              <div className="flex shrink-0 items-center">
                {(sdk || pano || sim) && plan && (
                  <ToolButton label={plan.status === "OK" ? (sim ? "Walk me there" : "Next stop") : "Face the item"} disabled={stepping} onClick={nextStop}>
                    {plan.status === "OK" ? <Footprints aria-hidden="true" /> : <Crosshair aria-hidden="true" />}
                  </ToolButton>
                )}
                <ToolButton label={folded ? "Show directions" : "Hide directions"} onClick={() => setFolded((v) => !v)}>
                  {folded ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
                </ToolButton>
                <ToolButton label="Clear route" onClick={() => wayfinding.clear()}><X aria-hidden="true" /></ToolButton>
              </div>
            </div>
            {folded && plan && <p className="m-0 font-mono text-label text-muted-foreground">{plan.totalDistanceM} m · {plan.waypointIds.length} stops</p>}
            {!folded && s.status === "choose" && (
              <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
                {s.options.map((option) => (
                  <li key={option.id}><Button variant="outline" className="h-11 w-full justify-start" onClick={() => wayfinding.choose(option)}>{option.name}</Button></li>
                ))}
              </ul>
            )}
            {!folded && s.status === "error" && <p className="m-0 mt-1 text-body text-muted-foreground">{s.message}</p>}
            {!folded && s.status === "ready" && (
              <>
                {/* The steps shown are always the planner's; the agent's words are only used when there is no route. */}
                {s.reply && !plan && <p className="m-0 mt-1 text-body">{s.reply}</p>}
                {s.plan && "reason" in s.plan && <p className="m-0 mt-1 text-body text-muted-foreground">{s.plan.reason}</p>}
                {plan && (
                  <>
                    <p className="m-0 mt-1 font-mono text-label text-muted-foreground">{plan.totalDistanceM} m · {plan.waypointIds.length} stops</p>
                    <ol className="m-0 mt-2 flex flex-col gap-1 pl-5 text-body">
                      {plan.legs.map((leg) => <li key={leg.index}>{leg.text}</li>)}
                    </ol>
                    {plan.warnings.map((warning) => <p key={warning} className="m-0 mt-2 text-label text-warning">{warning}</p>)}
                    {!sdk && !pano && !sim && <RouteMap plan={plan} className="mt-2 h-40 w-full rounded-md bg-muted" />}
                  </>
                )}
              </>
            )}
          </section>
        )}
      </div>
      {toolError && <p role="alert" className="absolute right-4 bottom-4 left-4 m-0 w-fit max-w-sm rounded-md bg-popover p-3 text-body text-destructive">{toolError}</p>}
    </main>
  );
}
