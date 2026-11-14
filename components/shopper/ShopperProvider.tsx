"use client";
// Shopper state: accessibility + privacy preferences (persisted on this device only), the polite live region,
// app voice, and search/destination state. Search and locations come from GET /api/products (published
// inventory only), so a staff approval or move is visible on the next request.
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AISLE_NAMES, DEMO_STORE } from "@/lib/seed/demo-store";
import type { PublishedProduct } from "@/lib/types";
import { carryPosition, postTurn, prefsPatch, toNavPrefs, type GuideNav, type GuideReply, type GuideTurn } from "./guide";

export type Contrast = "comfortable" | "dark" | "light";
export type Contribution = "allowed" | "declined" | null;
export interface Prefs {
  contrast: Contrast;
  scale: 1 | 1.3 | 1.6;
  speak: boolean;
  rate: 0.8 | 1 | 1.3;
  detail: "concise" | "detailed";
  /** Product contributions: neither option is selected until the shopper chooses. */
  contributions: Contribution;
}
const DEFAULT_PREFS: Prefs = { contrast: "comfortable", scale: 1, speak: true, rate: 1, detail: "concise", contributions: null };
const PREFS_KEY = "storeguide.shopper.prefs.v1";

export const THEMES = {
  comfortable: { bg: "#E9E4F3", surface: "#F7F5F0", text: "#252331", muted: "#5B5570", primary: "#44337A", primaryText: "#44337A", onPrimary: "#FFFFFF", border: "#776C95", tint: "#DCD3EC", warnBg: "#F8EBC8", warnBorder: "#E8B84B", err: "#8A2E12" },
  dark: { bg: "#121019", surface: "#1E1B2A", text: "#FFFFFF", muted: "#C9C3DA", primary: "#E8B84B", primaryText: "#E8B84B", onPrimary: "#121019", border: "#8D86A3", tint: "#3A3352", warnBg: "#2A2540", warnBorder: "#E8B84B", err: "#FF8A80" },
  light: { bg: "#FFFFFF", surface: "#FFFFFF", text: "#000000", muted: "#222222", primary: "#000000", primaryText: "#000000", onPrimary: "#FFFFFF", border: "#000000", tint: "#BBBBBB", warnBg: "#FFFFFF", warnBorder: "#000000", err: "#9B1C1C" },
} as const;
export type Theme = (typeof THEMES)[Contrast];

const AUX = ["/shopper/help", "/shopper/settings", "/shopper/consent", "/shopper/contribute"];
export const STORE_ID = DEMO_STORE.id;

interface ProductsResponse {
  resolution: { status: "MATCH"; product_id: string } | { status: "AMBIGUOUS"; product_ids: string[] } | { status: "NO_MATCH" };
  results: { product: PublishedProduct; score: number; spoken: string }[];
}

interface ShopperCtx {
  prefs: Prefs;
  setPrefs: (p: Partial<Prefs>) => void;
  t: Theme;
  live: string;
  say: (text: string, rate?: number) => void;
  msg: { text: string; err: boolean };
  setMsg: (text: string, err?: boolean) => void;
  q: string;
  setQ: (q: string) => void;
  results: PublishedProduct[];
  resQuery: string;
  selected: PublishedProduct | null;
  selectedLoc: string;
  setSelectedLoc: (v: string) => void;
  from: "search" | "results";
  runSearch: (q: string) => Promise<void>;
  select: (p: PublishedProduct, from: "search" | "results") => void;
  /** Re-read the selected product's published location. */
  refreshSelected: () => Promise<PublishedProduct | null | undefined>;
  aux: (path: string) => void;
  back: () => void;
  focusSearch: boolean;
  setFocusSearch: (v: boolean) => void;
  /** Shopper agent conversation (POST /api/agent/shopper). `online` is null until the first turn. */
  guide: GuideView;
  /** Voice entry point: sends the utterance to the agent; falls back to plain search when the agent is offline. */
  ask: (text: string) => Promise<void>;
  /** One agent turn (utterance and/or scan result). `speakErrors: false` shows an error without speaking it. */
  sendTurn: (turn: GuideTurn, opts?: { speakErrors?: boolean }) => Promise<TurnResult>;
  /** Start a new conversation. Keeps a known position (downgraded to LIKELY) so the shopper needn't scan again. */
  resetGuide: () => void;
}

/** ok: reply applied · busy: another turn is in flight (nothing sent) · stale: conversation was reset meanwhile · failed: error shown */
export type TurnResult = "ok" | "busy" | "stale" | "failed";

export interface GuideView {
  online: boolean | null;
  busy: boolean;
  nav: GuideNav;
  say: string;
  agentText: string;
  routeText: string[];
  choices: string[];
  /** What the shopper said last, shown above the reply. */
  heard: string;
  error: string;
}

const freshGuide = (): GuideView => ({
  online: null, busy: false, nav: { store_id: STORE_ID }, say: "", agentText: "", routeText: [], choices: [], heard: "", error: "",
});

const Ctx = createContext<ShopperCtx | null>(null);
export function useShopper(): ShopperCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useShopper must be used inside <ShopperProvider>");
  return c;
}

export const locKey = (p: PublishedProduct) => `${p.location.shelfId}|${p.location.level ?? ""}`;
export const spokenName = (p: PublishedProduct) => `${p.brand ? p.brand + " " : ""}${p.name}${p.size ? ", " + p.size : ""}`;
export const locText = (p: PublishedProduct) => `Aisle ${p.shelf.aisle}, Section ${p.shelf.section}${p.location.level ? `, ${p.location.level} shelf` : ""}`;

async function fetchProducts(query: string): Promise<ProductsResponse> {
  const r = await fetch(`/api/products?store_id=${encodeURIComponent(STORE_ID)}&query=${encodeURIComponent(query)}`, { cache: "no-store" });
  if (!r.ok) throw new Error(String(r.status));
  return (await r.json()) as ProductsResponse;
}

export function ShopperProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [prefs, setPrefsState] = useState<Prefs>(DEFAULT_PREFS);
  const [live, setLive] = useState("");
  const [msg, setMsgState] = useState({ text: "", err: false });
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PublishedProduct[]>([]);
  const [resQuery, setResQuery] = useState("");
  const [selected, setSelected] = useState<PublishedProduct | null>(null);
  const [selectedLoc, setSelectedLoc] = useState("");
  const [from, setFrom] = useState<"search" | "results">("search");
  const [prev, setPrev] = useState("/shopper");
  const [focusSearch, setFocusSearch] = useState(false);
  const [guide, setGuide] = useState<GuideView>(freshGuide);
  // Latest nav/history for the next request, independent of render timing; `busy` blocks overlapping turns.
  const guideRef = useRef<{ nav: GuideNav; history: unknown[]; busy: boolean; online: boolean | null }>({
    nav: { store_id: STORE_ID }, history: [], busy: false, online: null,
  });
  const prefsRef = useRef(prefs);
  // Current path for decisions made after an await (the closure's `path` can be stale by then).
  const pathRef = useRef(path);
  useEffect(() => {
    pathRef.current = path;
  }, [path]);
  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);
  // Preferences live on this device only. Storage can be unavailable (private mode), so failures are ignored.
  // Read once after mount (hydration-safe); write only when the shopper changes a preference, so a default
  // value can never overwrite a stored choice.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration from device storage
      if (raw) setPrefsState({ ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) });
    } catch {}
  }, []);
  useEffect(() => () => {
    try {
      window.speechSynthesis?.cancel();
    } catch {}
  }, []);

  const setPrefs = useCallback((p: Partial<Prefs>) => {
    setPrefsState((s) => {
      const next = { ...s, ...p };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const say = useCallback((text: string, rateOverride?: number) => {
    setLive(text);
    const { speak, rate } = prefsRef.current;
    if (!speak || typeof window === "undefined" || !window.speechSynthesis) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = rateOverride ?? rate;
      speechSynthesis.speak(u);
    } catch {}
  }, []);

  const setMsg = useCallback((text: string, err = false) => {
    setMsgState({ text, err });
    setLive(text);
  }, []);

  const select = useCallback(
    (p: PublishedProduct, f: "search" | "results") => {
      setSelected(p);
      setSelectedLoc(locKey(p));
      setFrom(f);
      setMsgState({ text: "", err: false });
      router.push("/shopper/destination");
      say(destinationSpeech(p, prefsRef.current.detail, AISLE_NAMES[p.shelf.aisle] ?? ""));
    },
    [router, say],
  );

  const runSearch = useCallback(
    async (query: string) => {
      const text = query.trim();
      if (!text) {
        setMsg("Type or say a product first.", true);
        return;
      }
      let data: ProductsResponse;
      try {
        data = await fetchProducts(text);
      } catch {
        setMsg("Search is not available right now. Try again, or choose Get Help.", true);
        return;
      }
      const byId = new Map(data.results.map((r) => [r.product.id, r.product]));
      const res = data.resolution;
      if (res.status === "NO_MATCH" || !data.results.length) {
        setMsg(`No product found for "${text}". Try another name, like oat milk or bread.`, true);
        say(`No product found for ${text}. Try another name.`);
        return;
      }
      if (res.status === "MATCH" && byId.get(res.product_id)) {
        select(byId.get(res.product_id)!, "search");
        return;
      }
      const ids = res.status === "AMBIGUOUS" ? res.product_ids : data.results.map((r) => r.product.id);
      const list = ids.map((id) => byId.get(id)).filter((p): p is PublishedProduct => !!p).slice(0, 5);
      setResults(list);
      setResQuery(text);
      setMsgState({ text: "", err: false });
      router.push("/shopper/results");
      say(`I found ${list.length} matches. ` + list.map((p, i) => `Option ${i + 1}: ${spokenName(p)}.`).join(" ") + " Choose one.");
    },
    [router, say, select, setMsg],
  );

  const refreshSelected = useCallback(async () => {
    if (!selected) return undefined;
    try {
      const data = await fetchProducts("");
      const cur = data.results.find((r) => r.product.id === selected.id)?.product ?? null;
      if (cur) setSelected(cur);
      return cur;
    } catch {
      return undefined;
    }
  }, [selected]);

  const sendTurn = useCallback(
    async (turn: GuideTurn, opts: { speakErrors?: boolean } = {}): Promise<TurnResult> => {
      const g = guideRef.current;
      if (g.busy) return "busy";
      g.busy = true;
      const sentPrefs = toNavPrefs(prefsRef.current);
      const nav: GuideNav = { ...g.nav, prefs: sentPrefs };
      setGuide((v) => ({ ...v, busy: true, error: "", heard: turn.utterance ?? (turn.scan ? "Scan finished." : v.heard) }));
      const res = await postTurn(nav, g.history, turn);
      g.busy = false;
      // "New search" (resetGuide) replaced the conversation while this turn was in flight: drop the late reply so it
      // can't overwrite the new conversation or be spoken over it.
      if (guideRef.current !== g) return "stale";
      if (!res.ok) {
        if (res.offline) g.online = false;
        setGuide((v) => ({ ...v, busy: false, online: res.offline ? false : v.online, error: res.say }));
        if (!res.offline && opts.speakErrors !== false) say(res.say);
        return "failed";
      }
      const reply: GuideReply = res.reply;
      g.nav = reply.nav;
      g.history = reply.history;
      g.online = true;
      const patch = prefsPatch(sentPrefs, reply.nav.prefs);
      if (patch) setPrefs(patch);
      setGuide((v) => ({
        ...v, online: true, busy: false, nav: reply.nav, say: reply.say, agentText: reply.agent_text,
        routeText: reply.route_text, choices: reply.choices, error: "",
      }));
      say(reply.say, reply.nav.prefs?.speech_rate);
      return "ok";
    },
    [say, setPrefs],
  );

  const ask = useCallback(
    async (text: string) => {
      const utterance = text.trim();
      if (!utterance) {
        setMsg("Type or say a product first.", true);
        return;
      }
      // A function, not a narrowed property read: sendTurn changes `online` while we await it.
      const offline = () => guideRef.current.online === false;
      if (!offline()) {
        // Off the guide screen a failure falls back to plain search below, which speaks its own result: don't speak the
        // agent's error first (it would be cut off mid-sentence).
        const r = await sendTurn({ utterance }, { speakErrors: pathRef.current === "/shopper/guide" });
        if (r === "ok") {
          if (pathRef.current !== "/shopper/guide") router.push("/shopper/guide");
          return;
        }
        if (r === "busy") {
          // Don't start a second request (or a plain search) while the assistant is still answering.
          setMsg("Still working on your last request. Try again in a moment.");
          return;
        }
        if (r === "stale") return;
        // One-off failure on the guide screen: the error is already shown and spoken there.
        if (!offline() && pathRef.current === "/shopper/guide") return;
      }
      // Agent offline (no API key) or unreachable from the search screen: plain search still works.
      await runSearch(utterance);
    },
    [router, runSearch, sendTurn, setMsg],
  );

  const resetGuide = useCallback(() => {
    const { online, nav: old } = guideRef.current;
    const nav: GuideNav = { store_id: STORE_ID, ...carryPosition(old) };
    guideRef.current = { nav, history: [], busy: false, online };
    setGuide({ ...freshGuide(), online, nav });
  }, []);

  const aux = useCallback(
    (target: string) => {
      if (!AUX.includes(path)) setPrev(path);
      router.push(target);
    },
    [path, router],
  );
  const back = useCallback(() => router.push(prev), [prev, router]);

  const value = useMemo<ShopperCtx>(
    () => ({
      prefs, setPrefs, t: THEMES[prefs.contrast], live, say, msg, setMsg, q, setQ, results, resQuery, selected, selectedLoc, setSelectedLoc,
      from, runSearch, select, refreshSelected, aux, back, focusSearch, setFocusSearch, guide, ask, sendTurn, resetGuide,
    }),
    [prefs, setPrefs, live, say, msg, setMsg, q, results, resQuery, selected, selectedLoc, from, runSearch, select, refreshSelected, aux, back, focusSearch, guide, ask, sendTurn, resetGuide],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The destination sentence, shared by the destination screen's "Hear location". */
export function destinationSpeech(p: PublishedProduct, detail: Prefs["detail"], aisleName: string) {
  return detail === "detailed"
    ? `${spokenName(p)}. Verified at ${locText(p)}, in ${aisleName}. Guided directions are not available yet in this prototype.`
    : `${spokenName(p)}. ${locText(p)}.`;
}
