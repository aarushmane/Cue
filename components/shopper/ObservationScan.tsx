"use client";
// "Help map this store": an explicit, consented observation scan.
// - The camera is requested only when the shopper chooses Start observation scan.
// - The preview stays on this device. No frame is captured or uploaded: recognition here is a labelled demo
//   (the vision pipeline is not connected), and Submit sends structured text only.
// - Ending the scan, leaving the screen, or withdrawing consent stops every camera track.
import { useEffect, useRef, useState, useTransition } from "react";
import { submitShopperObservationDemo } from "@/lib/demo/adapter";
import { candLoc } from "@/lib/review/format";
import { DEMO_RECOGNITION } from "@/lib/seed/demo-review";
import { useShopper } from "./ShopperProvider";
import { sBtn } from "./ShopperShell";

type Cam = "idle" | "requesting" | "on" | "blocked" | "unavailable";
const CAM_TEXT: Record<Cam, string> = {
  idle: "Camera: not in use.",
  requesting: "Camera: asking for permission…",
  on: "Camera: on for this scan only. Video stays on this device.",
  blocked: "Camera: permission blocked. Demo recognition still works, or allow the camera in browser settings.",
  unavailable: "Camera: not available here. Demo recognition still works.",
};

export function ObservationScan() {
  const s = useShopper();
  const allowed = s.prefs.contributions === "allowed";
  const [scan, setScan] = useState(false);
  const [cam, setCam] = useState<Cam>("idle");
  const [detectIdx, setDetectIdx] = useState<number | null>(null);
  const [nextIdx, setNextIdx] = useState(0);
  const [submitted, setSubmitted] = useState("");
  const [busy, start] = useTransition();
  const stream = useRef<MediaStream | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const scanRef = useRef(false);

  const stopTracks = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };
  const stopScan = () => {
    scanRef.current = false;
    stopTracks();
    setScan(false);
    setCam("idle");
    setDetectIdx(null);
  };

  // Leaving the screen stops the camera.
  useEffect(() => () => {
    scanRef.current = false;
    stopTracks();
  }, []);

  // Withdrawn consent ends the scan.
  useEffect(() => {
    if (!allowed && scanRef.current) {
      scanRef.current = false;
      stopTracks();
      setScan(false);
      setCam("idle");
      setDetectIdx(null);
    }
  }, [allowed]);

  useEffect(() => {
    const v = video.current;
    if (v && stream.current && v.srcObject !== stream.current) {
      v.srcObject = stream.current;
      v.muted = true;
      v.playsInline = true;
      v.play().catch(() => {});
    }
  }, [cam]);

  const startScan = async () => {
    if (!allowed) return;
    scanRef.current = true;
    setScan(true);
    setDetectIdx(null);
    setSubmitted("");
    setCam("requesting");
    s.say("Observation scan started. Point the camera at a product, then choose Identify product.");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error("unsupported"), { name: "NotSupportedError" });
      const st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      if (!scanRef.current) {
        st.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = st;
      setCam("on");
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (scanRef.current) setCam(name === "NotAllowedError" || name === "SecurityError" ? "blocked" : "unavailable");
    }
  };

  const identify = () => {
    const i = nextIdx % DEMO_RECOGNITION.length;
    const smp = DEMO_RECOGNITION[i];
    setDetectIdx(i);
    setNextIdx(nextIdx + 1);
    setSubmitted("");
    s.say(`Possible product: ${smp.brand} ${smp.name}, ${smp.size}. ${smp.confidence} confidence. Choose Submit for staff review, or Discard.`);
  };

  const submit = () =>
    start(async () => {
      if (detectIdx === null || !allowed || !scan) return;
      const d = DEMO_RECOGNITION[detectIdx];
      const r = await submitShopperObservationDemo({ consent: s.prefs.contributions, confidence: d.confidence, evidence: d.evidence, candidate: d.candidate });
      const msg = r.ok ? r.message : `Not sent: ${r.error}`;
      setDetectIdx(null);
      setSubmitted(msg);
      s.say(msg);
    });

  const detect = detectIdx === null ? null : DEMO_RECOGNITION[detectIdx];

  return (
    <>
      <div role="status" aria-live="polite" className={`flex flex-col gap-[0.3em] border-[3px] ${sBtn.card}`}>
        <strong className="text-[1.1em]">{scan ? "Scanning: On. Nothing is sent until you choose Submit." : "Scanning: Off. Nothing is being collected."}</strong>
        <span className="text-[0.95em]">{CAM_TEXT[cam]}</span>
      </div>
      <p className="m-0 text-[0.95em]">
        {allowed
          ? "Contributions: allowed. Change this in Accessibility and privacy settings."
          : s.prefs.contributions === "declined"
            ? "Contributions: off. Search, directions and help still work."
            : "Contributions: not chosen yet. Nothing is collected."}
      </p>
      {!allowed && (
        <button type="button" onClick={() => s.aux("/shopper/consent")} className={`${sBtn.primary} px-4 text-[1.1em]`}>
          Review contribution choice
        </button>
      )}
      {allowed && !scan && (
        <button type="button" onClick={startScan} className={`${sBtn.primary} px-4 text-[1.1em]`}>
          Start observation scan
        </button>
      )}
      {scan && (
        <>
          {cam === "on" && (
            <video ref={video} aria-label="Camera preview, shown only on this device" className="block aspect-[4/3] w-full rounded-[24px] bg-black object-cover" />
          )}
          <button type="button" onClick={identify} className={`${sBtn.primary} px-4 text-[1.1em]`}>
            Identify product in view
          </button>
          {detect && (
            <>
              <section aria-labelledby="det-h" className={`flex flex-col gap-[0.3em] border-[3px] ${sBtn.card}`}>
                <span className="text-[0.85em] font-extrabold tracking-[.04em] text-(--s-muted)">POSSIBLE PRODUCT · DEMO RECOGNITION</span>
                <h2 id="det-h" className="m-0 text-[1.3em] leading-[1.2] font-extrabold">{detect.brand} {detect.name}</h2>
                <span>
                  {detect.candidate.category} · {detect.size} · {detect.confidence} confidence
                </span>
                <span>Estimated location: {candLoc(detect.candidate)}.{detect.candidate.level ? "" : " Level not detected."}</span>
                <span className="text-[0.9em] text-(--s-muted)">{detect.evidence}</span>
              </section>
              <div className="grid grid-cols-2 gap-2.5">
                <button type="button" disabled={busy} onClick={submit} className={`${sBtn.primary} px-4 text-[1.1em] disabled:opacity-45`}>
                  Submit for staff review
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDetectIdx(null);
                    s.say("Discarded. Nothing was sent.");
                  }}
                  className={`${sBtn.secondary} px-4 text-[1.1em]`}
                >
                  Discard
                </button>
              </div>
            </>
          )}
          <button
            type="button"
            onClick={() => {
              stopScan();
              s.say("Observation scan ended. Nothing more is collected.");
            }}
            className={`${sBtn.secondary} px-4 text-[1.1em]`}
          >
            End scan
          </button>
        </>
      )}
      {submitted && <p role="status" className={`m-0 font-semibold ${sBtn.card}`}>{submitted}</p>}
      <p className="m-0 text-[0.9em] text-(--s-muted)">
        Only product details are submitted. Recognition is a demo here (vision service not connected), and no image leaves this device.
      </p>
      <button type="button" onClick={() => s.aux("/shopper/help")} className={`${sBtn.secondary} px-4 text-[1.1em]`}>
        Get Help
      </button>
    </>
  );
}
