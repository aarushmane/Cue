"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { MpSdk } from "@matterport/sdk";
import { ArrowRight, ChevronDown, ChevronUp, Crosshair, Expand, Footprints, LoaderCircle, RotateCcw, Search, Shrink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { Logo } from "@/components/workspace/Logo";
import { VoicePanel } from "@/components/workspace/VoicePanel";
import { wrapHeading, type ViewControls, type VoiceResult, type ViewPose } from "@/lib/voice/types";
import { guidanceFor } from "@/lib/voice/guidance";
import { lookAhead } from "@/lib/wayfinding/screen";
import { RouteMap } from "./RouteMap";
import { PanoViewer, type PanoSweep } from "./PanoViewer";
import { SimViewer } from "@/components/sim/SimViewer";
import type { Vec3 } from "@/lib/wayfinding/types";
import { aboutSteps } from "@/lib/wayfinding/steps";
import { RouteOverlay } from "./RouteOverlay";
import { connectShowcase, headingDegrees, SDK_KEY, stepAlong, toApi, toSdk, watchSweeps, type ClientWaypoint, type Pose } from "./showcase";
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
  const velocity = useRef({ mps: 0, at: 0 });
  const [status, setStatus] = useState<"loading" | "ready">("loading");
  const [session, setSession] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [toolError, setToolError] = useState("");
  const [sdk, setSdk] = useState<MpSdk | null>(null);
  const [query, setQuery] = useState("");
  const [stepping, setStepping] = useState(false);
  const viewControl = useRef<ViewControls | null>(null);
  const motion = useRef<AbortController | null>(null);
  const interruptVoice = useRef<(() => void) | null>(null);
  // The route panel folds down to one line so it doesn't cover the tour.
  const [folded, setFolded] = useState(false);
  // Walkable simulation (no SDK key): where the visitor stands, and a counter that starts "walk me there".
  const [simFailed, setSimFailed] = useState(false);
  const sim = !SDK_KEY && !simFailed;
  const simFloor = useRef<Vec3 | null>(null);
  // Built-in 360° viewer (fallback): which scan point the visitor stands on.
  const [panoFailed, setPanoFailed] = useState(false);
  const pano = !SDK_KEY && simFailed && !panoFailed;
  const [sweepId, setSweepId] = useState<string | null>(null);
  const firstSweep = useRef<string | null>(null);
  const [faceKey, setFaceKey] = useState(0);

  const sweeps = useRef<ClientWaypoint[]>([]);
  const context = useCallback(() => {
    if (sim) {
      const position = viewControl.current?.pose?.()?.position ?? simFloor.current;
      return { start: position ? { position } : {} };
    }
    if (pano) return { start: sweepId ? { sweep_id: sweepId } : {} };
    const current = pose.current;
    if (!sdk || !current) return { start: {} };
    return {
      start: { sweep_id: current.sweep || undefined, position: toApi(sdk, current.position) },
      waypoints: sweeps.current.length ? sweeps.current : undefined,
    };
  }, [sdk, sim, pano, sweepId]);
  const wayfinding = useWayfinding(modelId, context);
  const { reroute, cancel: cancelWayfinding } = wayfinding;
  const currentRoute = useRef(wayfinding.state);
  useEffect(() => { currentRoute.current = wayfinding.state; }, [wayfinding.state]);
  const stopMovement = useCallback(() => {
    motion.current?.abort();
    motion.current = null;
    viewControl.current?.stop();
    cancelWayfinding();
    setStepping(false);
    // Current SDK exposes stop(); older embeds may omit it. Always cancel the queue regardless.
    if (sdk?.Camera.stop) void sdk.Camera.stop().catch(() => {});
  }, [sdk, cancelWayfinding]);
  useEffect(() => () => { motion.current?.abort(); viewControl.current?.stop(); }, []);

  const onSweeps = useCallback((list: PanoSweep[]) => {
    sweeps.current = list.map((s) => ({ id: s.id, position: s.position, floor_id: null, neighbors: s.neighbors }));
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
    // Guidance already follows a fixed obstacle-checked path. Replanning each step
    // can change its approach point while the visitor is still following it.
    if (!viewControl.current?.guiding?.()) void reroute({ position: floor });
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
      const sub = connected.Camera.pose.subscribe((next) => {
        const now = performance.now();
        const previous = pose.current;
        const dt = (now - velocity.current.at) / 1000;
        const p = toApi(connected, next.position);
        const before = previous ? toApi(connected, previous.position) : p;
        velocity.current = { at: now, mps: previous && dt > 0.01 && dt < 1 ? Math.hypot(p.x - before.x, p.y - before.y) / dt : 0 };
        pose.current = next;
      });
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
    interruptVoice.current?.();
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
    interruptVoice.current?.();
    if (query.trim()) { setFolded(false); wayfinding.find(query.trim()); }
  }

  async function nextStop() {
    interruptVoice.current?.();
    if (sim && plan) { viewControl.current?.guide?.(plan); return; }
    if (pano && plan) {
      const ids = plan.waypointIds;
      const at = sweepId ? ids.indexOf(sweepId) : -1;
      if (at >= 0 && at < ids.length - 1) setSweepId(ids[at + 1]);
      else if (at === -1 && ids.length) setSweepId(ids[0]);
      else setFaceKey((k) => k + 1);
      return;
    }
    if (!sdk || !plan || !pose.current) return;
    const move = new AbortController();
    motion.current = move;
    setStepping(true);
    try {
      const ids = plan.waypointIds;
      // After each move, face 2.5 m further along the route from where Showcase put us; at the last stop, the item.
      await stepAlong(sdk, ids, pose.current.sweep, (i) =>
        i >= ids.length - 1 || !pose.current ? plan.item.position : lookAhead(plan.polyline, toApi(sdk, pose.current.position), 2.5), move.signal);
    } catch {
      if (!move.signal.aborted) setToolError("Could not move to the next stop.");
    } finally {
      if (motion.current === move) { motion.current = null; setStepping(false); }
    }
  }

  async function guideRoute(nextPlan: NonNullable<typeof plan>) {
    stopMovement();
    if (sim) { viewControl.current?.guide?.(nextPlan); return; }
    const move = new AbortController();
    motion.current = move;
    setStepping(true);
    try {
      if (pano) {
        // Photo fallback has discrete jumps; cancelling prevents every subsequent jump.
        const at = sweepId ? nextPlan.waypointIds.indexOf(sweepId) : -1;
        for (const id of nextPlan.waypointIds.slice(Math.max(0, at + 1))) {
          move.signal.throwIfAborted();
          setSweepId(id);
          await new Promise<void>((resolve, reject) => {
            const cancel = () => { clearTimeout(timer); reject(new DOMException("Stopped", "AbortError")); };
            const timer = setTimeout(() => { move.signal.removeEventListener("abort", cancel); resolve(); }, 1200);
            move.signal.addEventListener("abort", cancel, { once: true });
          });
        }
        move.signal.throwIfAborted();
        setFaceKey((key) => key + 1);
      } else if (sdk && pose.current) {
        const ids = nextPlan.waypointIds;
        for (let i = 0; i <= ids.length; i++) {
          move.signal.throwIfAborted();
          await stepAlong(sdk, ids, pose.current.sweep, (at) => at >= ids.length - 1 ? nextPlan.item.position
            : lookAhead(nextPlan.polyline, toApi(sdk, pose.current!.position), 2.5), move.signal);
          if (pose.current.sweep === ids.at(-1)) break;
        }
      } else throw new Error("Voice movement needs the 3D viewer or a connected Matterport SDK.");
    } catch (error) {
      if (!move.signal.aborted) setToolError(error instanceof Error ? error.message : "Could not follow the route.");
    } finally {
      if (motion.current === move) { motion.current = null; setStepping(false); }
    }
  }

  function applyVoice(result: VoiceResult) {
    if (result.resetDestination) { currentRoute.current = { status: "idle" }; wayfinding.clear(); }
    if (result.plan && "item" in result.plan && result.item && result.item.id !== result.plan.item.id) {
      stopMovement(); setToolError("Destination changed unexpectedly. Please search again."); return;
    }
    if (result.plan) {
      currentRoute.current = { status: "ready", query: result.item?.name ?? query, reply: result.reply, item: result.item, plan: result.plan };
      wayfinding.adopt(result.item?.name ?? query, result.reply, result.item, result.plan);
      setQuery(result.item?.name ?? query);
      setFolded(false);
    }
    for (const action of result.actions) {
      if (action.type === "stop") stopMovement();
      else if (action.type === "turn") {
        stopMovement();
        if (viewControl.current) viewControl.current.turn(action.degrees);
        else if (sdk) {
          const move = new AbortController(); motion.current = move;
          // Model-frame left is positive; Showcase's horizontal angle is clockwise positive.
          void sdk.Camera.rotate(-action.degrees, 0).catch(() => { if (!move.signal.aborted) setToolError("Could not turn the view."); })
            .finally(() => { if (motion.current === move) motion.current = null; });
        } else setToolError("Turning needs the 3D viewer or a connected Matterport SDK.");
      } else if (action.type === "speed") {
        if (viewControl.current?.speed) viewControl.current.speed(action.metersPerSecond);
        else setToolError("Walking speed is available in the 3D simulation.");
      } else if (action.type === "face") {
        const route = result.plan ?? (currentRoute.current.status === "ready" ? currentRoute.current.plan : null);
        if (!route || !("item" in route)) continue;
        const position = viewControl.current?.pose?.()?.position ?? simFloor.current;
        const target = action.target === "destination" || !position ? route.item.position : lookAhead(route.polyline, position, 1.2);
        if (viewControl.current?.face) viewControl.current.face(target);
        else if (sdk) void sdk.Camera.lookAt(toSdk(sdk, target)).catch(() => setToolError("Could not orient the view."));
      } else if (action.type === "move") {
        const nextPlan = result.plan ?? plan;
        if (nextPlan?.status === "OK" || nextPlan?.status === "ALREADY_THERE") void guideRoute(nextPlan);
      }
    }
  }

  function livePose(): ViewPose | null {
    const local = viewControl.current?.pose?.();
    if (local) return local;
    if (!sdk || !pose.current) return null;
    return { position: toApi(sdk, pose.current.position), headingDeg: wrapHeading(headingDegrees(sdk, pose.current)),
      speedMps: performance.now() - velocity.current.at < 500 ? velocity.current.mps : 0, moving: Boolean(motion.current) };
  }

  const s = wayfinding.state;
  return (
    <div className="workspace">
      <div className="workspace-body">
        <main className="explore-pane" aria-label="Map">
          <section ref={viewport} className="scene" aria-label={name}>
      {sim ? (
        <SimViewer key={session} modelId={modelId} plan={plan} controlRef={viewControl} onPosition={onSimPosition} onUnavailable={onSimUnavailable} />
      ) : pano ? (
        <PanoViewer
          key={session}
          modelId={modelId}
          sweepId={sweepId}
          plan={plan}
          faceKey={faceKey}
          controlRef={viewControl}
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
      <div className="scene-toolbar">
        <div className="scene-tools" role="group" aria-label="Scene tools">
          <ToolButton label="Reset view" disabled={!pano && !sim && status !== "ready"} onClick={resetView}><RotateCcw aria-hidden="true" /></ToolButton>
          <Separator orientation="vertical" className="h-5" />
          <ToolButton label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"} onClick={toggleFullscreen}>
            {fullscreen ? <Shrink aria-hidden="true" /> : <Expand aria-hidden="true" />}
          </ToolButton>
        </div>
      </div>
      <div className="scene-route-container">

        {s.status !== "idle" && s.status !== "loading" && (
          <section className="route-panel" aria-live="polite" aria-label="Route">
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
                <ToolButton label="Clear route" onClick={() => { interruptVoice.current?.(); wayfinding.clear(); }}><X aria-hidden="true" /></ToolButton>
              </div>
            </div>
            {folded && plan && <p className="m-0 font-mono text-label text-muted-foreground">{plan.status === "ALREADY_THERE" ? "You're there" : aboutSteps(plan.totalDistanceM)}</p>}
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
                    <p className="m-0 mt-1 font-mono text-label text-muted-foreground">{plan.status === "ALREADY_THERE" ? "You're there" : aboutSteps(plan.totalDistanceM)}</p>
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
          </section>
        </main>
        <VoicePanel interruptRef={interruptVoice} modelId={modelId} onPickItem={setQuery} activity={s.status === "loading" ? "Finding destination" : null} search={<>
          <Logo />
          <form onSubmit={submit} className="destination-search" role="search" aria-label="Search the map">
            <Search className="search-leading size-4" aria-hidden="true" />
            <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
              placeholder="Search" aria-label="Find an item" maxLength={300}
              className="h-12 border-border bg-popover pl-10 pr-12 text-popover-foreground" />
            <Button type="submit" variant="ghost" size="icon" className="search-submit size-10" aria-label="Find"
              disabled={!query.trim() || s.status === "loading"}>
              {s.status === "loading" ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ArrowRight className="size-4" aria-hidden="true" />}
            </Button>
          </form>
        </>} bridge={{
          context: () => {
            const current = currentRoute.current;
            const item = current.status === "ready" ? current.item : null;
            const live = livePose();
            const heading = live?.headingDeg ?? viewControl.current?.heading();
            return { model_id: modelId, ...context(), heading_deg: heading === undefined ? undefined : wrapHeading(heading), speed_mps: live?.speedMps ?? 0, walking_speed_mps: live?.walkingSpeedMps,
              moving: Boolean(motion.current || live?.moving), observed_at: Date.now(), ...(item ? { current_item_id: item.id, items: [item] } : {}) };
          },
          apply: applyVoice,
          stop: stopMovement,
          moving: () => Boolean(motion.current || viewControl.current?.moving()),
          guidance: () => {
            const current = currentRoute.current;
            if (current.status !== "ready" || !current.plan) return null;
            const live = livePose();
            const position = live?.position ?? (sim ? simFloor.current : pano ? sweeps.current.find((s) => s.id === sweepId)?.position
              : sdk && pose.current ? toApi(sdk, pose.current.position) : null);
            const heading = live?.headingDeg ?? viewControl.current?.heading();
            return position ? guidanceFor(current.plan, position, heading, live?.speedMps) : null;
          },
        }} />
      </div>
    </div>
  );
}
