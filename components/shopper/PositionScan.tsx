"use client";
// "Find my position": a short camera scan for localization (POST /api/localize), then one agent turn with the result.
// - The camera opens only after the shopper taps Scan, captures up to 3 frames over ~1.5 s, and every track is
//   stopped right after (also when leaving the screen). Frames are sent once and never stored by the server.
// - Products seen in the frames are shared as text only when the shopper allowed product contributions.
// - "I'm at the entrance" is a shopper-stated position (LIKELY, never CONFIRMED) for when the camera can't be used.
import { useEffect, useRef, useState } from "react";
import { DEMO_NODES } from "@/lib/seed/demo-store";
import type { LocalizeResult } from "@/lib/types";
import { STORE_ID, useShopper } from "./ShopperProvider";
import { sBtn } from "./ShopperShell";

type Phase = "idle" | "camera" | "sending" | "error";
const FRAMES = 3;
const GAP_MS = 600;
const MAX_W = 768;

const ENTRANCE = DEMO_NODES.find((n) => n.kind === "entrance");

function grab(video: HTMLVideoElement): string | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  const scale = Math.min(1, MAX_W / w);
  const c = document.createElement("canvas");
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  c.getContext("2d")?.drawImage(video, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.7);
}

export function PositionScan() {
  const s = useShopper();
  const [phase, setPhase] = useState<Phase>("idle");
  const [note, setNote] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);

  const stop = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };
  useEffect(() => stop, []);

  const finish = async (scan: LocalizeResult) => {
    setPhase("sending");
    const ok = await s.sendTurn({ scan });
    setPhase(ok ? "idle" : "error");
  };

  const scan = async () => {
    if (phase === "camera" || phase === "sending" || s.guide.busy) return;
    setNote("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setPhase("error");
      setNote("The camera is not available in this browser. You can say where you are instead.");
      return;
    }
    try {
      setPhase("camera");
      s.say("Scanning. Slowly pan your phone left to right.");
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      const v = video.current!;
      v.srcObject = stream.current;
      await v.play();
      const frames: string[] = [];
      for (let i = 0; i < FRAMES; i++) {
        await new Promise((r) => setTimeout(r, i === 0 ? 300 : GAP_MS));
        const f = grab(v);
        if (f) frames.push(f);
      }
      stop();
      v.srcObject = null;
      if (!frames.length) throw new Error("no frames");
      setPhase("sending");
      const r = await fetch("/api/localize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          store_id: STORE_ID,
          frames,
          previous_node_id: s.guide.nav.current_node_id ?? null,
          share_sightings: s.prefs.contributions === "allowed",
        }),
      });
      const body = (await r.json().catch(() => null)) as LocalizeResult | null;
      if (r.status === 503) {
        setPhase("error");
        setNote("Camera position finding is not set up on this server. Say where you are, or ask staff for help.");
        s.say("Camera position finding is not available. Say where you are, or ask staff for help.");
        return;
      }
      if (!body || typeof body.confidence_state !== "string") throw new Error("bad response");
      await finish(body);
    } catch (e) {
      stop();
      const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
      setPhase("error");
      const text = denied
        ? "Camera permission is off. Allow it in browser settings, or say where you are."
        : "The scan did not work. Try again, or say where you are.";
      setNote(text);
      s.say(text);
    }
  };

  const atEntrance = () => {
    if (!ENTRANCE || s.guide.busy) return;
    void finish({
      confidence_state: "LIKELY",
      selected_node_id: ENTRANCE.id,
      candidate_node_ids: [ENTRANCE.id],
      landmark_id: null,
      evidence: "The shopper said they are at the store entrance.",
    });
  };

  const busy = phase === "camera" || phase === "sending" || s.guide.busy;
  return (
    <section aria-labelledby="scan-h" className={`${sBtn.card} flex flex-col gap-[0.7em]`}>
      <h2 id="scan-h" className="m-0 text-[1.2em] font-extrabold">Find my position</h2>
      <p className="m-0 text-[1em]">
        Directions need your position. Hold your phone at chest height and tap Scan. The camera turns off by itself after about two seconds.
      </p>
      {/* Muted, inline preview; hidden from assistive tech (it carries no information). */}
      <video ref={video} muted playsInline aria-hidden="true" className={phase === "camera" ? "w-full rounded-[18px]" : "hidden"} />
      <button type="button" onClick={() => void scan()} aria-disabled={busy || undefined} className={`${sBtn.primary} text-[1.1em]`}>
        {phase === "camera" ? "Scanning…" : phase === "sending" ? "Finding your position…" : "Scan"}
      </button>
      {ENTRANCE && (
        <button type="button" onClick={atEntrance} aria-disabled={busy || undefined} className={`${sBtn.secondary} text-[1em]`}>
          I&apos;m at the store entrance
        </button>
      )}
      {note && (
        <p role="alert" className="m-0 text-[1em] font-semibold" style={{ color: s.t.err }}>
          {note}
        </p>
      )}
    </section>
  );
}
