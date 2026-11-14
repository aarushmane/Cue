"use client";
// Manager-side state shared across Home, Floor Plan, Review, Inventory and Activity.
// Server data (products, observations, audit, maps) comes only from the demo adapter's snapshot; the UI never
// writes it locally, so what you see is what the backend accepted. Staff writes go to the API routes
// (lib/staff/client.ts), which don't return a snapshot, so screens call refresh() after each one. UI-only state (open sheet, unsaved
// review edits, the floor plan draft being edited) lives here so switching tabs does not lose it.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { resetDemoDataDemo } from "@/lib/demo/adapter";
import { loadStaffSnapshot } from "@/lib/staff/client";
import type { DemoFail, StaffSnapshot } from "@/lib/demo/types";
import type { FloorPlan, ReviewDraft } from "@/lib/types";

export interface ReviewNotice {
  id: string;
  routeFlag: boolean;
}

interface StaffCtx {
  snap: StaffSnapshot | null;
  loadError: string | null;
  /** Adopt the server snapshot attached to an adapter result (success or failure). */
  apply: (r: { snapshot?: StaffSnapshot } | DemoFail) => void;
  /** Re-read the snapshot after an API route write (routes don't return one). Null if the read failed. */
  refresh: () => Promise<StaffSnapshot | null>;
  toast: (msg: string) => void;
  toastMsg: string;
  reset: () => Promise<void>;
  // Review
  reviewId: string | null;
  setReviewId: (id: string | null) => void;
  rTab: "pending" | "reviewed";
  setRTab: (t: "pending" | "reviewed") => void;
  drafts: Record<string, ReviewDraft>;
  setDraft: (id: string, d: ReviewDraft | null) => void;
  notice: ReviewNotice | null;
  setNotice: (n: ReviewNotice | null) => void;
  simulateFailure: boolean;
  setSimulateFailure: (v: boolean) => void;
  // Sheets hosted by the shell
  shelfSheet: string | null;
  openShelf: (id: string | null) => void;
  productSheet: string | null;
  openProduct: (id: string | null) => void;
  // Home
  homeShelf: string;
  setHomeShelf: (id: string) => void;
  // Floor plan editor (local working copy; saved via the adapter)
  fp: FloorPlanUi;
  setFp: (patch: Partial<FloorPlanUi> | ((s: FloorPlanUi) => Partial<FloorPlanUi>)) => void;
  sheetHost: HTMLDivElement | null;
  setSheetHost: (el: HTMLDivElement | null) => void;
}

export interface FloorPlanUi {
  mode: "view" | "edit";
  draft: FloorPlan | null;
  dirty: boolean;
  tool: "select" | "shelf" | "entrance" | "landmark" | "walk" | "connect";
  sel: { type: "shelf" | "node" | "landmark"; key: string } | null;
  connectFrom: string | null;
  route: string;
  view: { z: number; tx: number; ty: number };
  q: string;
  confirm: boolean;
}

const FP0: FloorPlanUi = {
  mode: "view", draft: null, dirty: false, tool: "select", sel: null, connectFrom: null, route: "", view: { z: 1, tx: 0, ty: 0 }, q: "", confirm: false,
};

const Ctx = createContext<StaffCtx | null>(null);

export function useStaff(): StaffCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useStaff must be used inside <StaffProvider>");
  return c;
}

/** Convenience for screens that need loaded data. */
export function useSnap(): StaffSnapshot {
  const { snap } = useStaff();
  if (!snap) throw new Error("Snapshot not loaded");
  return snap;
}

/**
 * Wraps a manager page so the page segment always renders (required for instant-navigation validation), showing
 * a loading or error message until the demo snapshot has arrived.
 */
export function withSnap<P extends object>(Page: ComponentType<P>) {
  function SnapGate(props: P) {
    const { snap, loadError } = useStaff();
    if (!snap) {
      return (
        <p role="status" className="m-0 mt-6 rounded-[26px] border-[1.5px] border-card bg-ivory px-[18px] py-4 text-[15px]">
          {loadError ?? "Loading store data…"}
        </p>
      );
    }
    return <Page {...props} />;
  }
  return SnapGate;
}

export function StaffProvider({ children }: { children: ReactNode }) {
  const [snap, setSnap] = useState<StaffSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState("");
  const tt = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [rTab, setRTab] = useState<"pending" | "reviewed">("pending");
  const [drafts, setDrafts] = useState<Record<string, ReviewDraft>>({});
  const [notice, setNotice] = useState<ReviewNotice | null>(null);
  const [simulateFailure, setSimulateFailure] = useState(false);
  const [shelfSheet, setShelfSheet] = useState<string | null>(null);
  const [productSheet, setProductSheet] = useState<string | null>(null);
  const [homeShelf, setHomeShelf] = useState("S-A3-2");
  const [fp, setFpState] = useState<FloorPlanUi>(FP0);
  const [sheetHost, setSheetHost] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    loadStaffSnapshot()
      .then((r) => {
        if (!live) return;
        if (r.ok) setSnap(r.snapshot);
        else setLoadError(r.error);
      })
      .catch(() => live && setLoadError("Could not load store data. Check that the server is running, then reload."));
    return () => {
      live = false;
    };
  }, []);

  const toast = useCallback((msg: string) => {
    clearTimeout(tt.current);
    setToastMsg(msg);
    tt.current = setTimeout(() => setToastMsg(""), 4200);
  }, []);

  const apply = useCallback((r: { snapshot?: StaffSnapshot } | DemoFail) => {
    if (r.snapshot) setSnap(r.snapshot);
  }, []);

  const refresh = useCallback(async () => {
    const r = await loadStaffSnapshot().catch(() => null);
    if (!r?.ok) return null;
    setSnap(r.snapshot);
    return r.snapshot;
  }, []);

  const setDraft = useCallback((id: string, d: ReviewDraft | null) => {
    setDrafts((all) => {
      const next = { ...all };
      if (d) next[id] = d;
      else delete next[id];
      return next;
    });
  }, []);

  const setFp = useCallback((patch: Partial<FloorPlanUi> | ((s: FloorPlanUi) => Partial<FloorPlanUi>)) => {
    setFpState((s) => ({ ...s, ...(typeof patch === "function" ? patch(s) : patch) }));
  }, []);

  const reset = useCallback(async () => {
    const r = await resetDemoDataDemo();
    if (!r.ok) {
      toast(r.error);
      return;
    }
    setSnap(r.snapshot);
    setDrafts({});
    setReviewId(null);
    setNotice(null);
    setShelfSheet(null);
    setProductSheet(null);
    setFpState(FP0);
    toast("Demo data reset to the seed.");
  }, [toast]);

  const value = useMemo<StaffCtx>(
    () => ({
      snap, loadError, apply, refresh, toast, toastMsg, reset,
      reviewId, setReviewId, rTab, setRTab, drafts, setDraft, notice, setNotice, simulateFailure, setSimulateFailure,
      shelfSheet, openShelf: (id) => { setShelfSheet(id); if (id) setProductSheet(null); },
      productSheet, openProduct: (id) => { setProductSheet(id); if (id) setShelfSheet(null); },
      homeShelf, setHomeShelf, fp, setFp, sheetHost, setSheetHost,
    }),
    [snap, loadError, apply, refresh, toast, toastMsg, reset, reviewId, rTab, drafts, setDraft, notice, simulateFailure, shelfSheet, productSheet, homeShelf, fp, setFp, sheetHost],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
