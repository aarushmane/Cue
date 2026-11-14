// In-memory demo backend for the v4 staff workflow (observations, review, product moves, floor plan, audit).
// Used only when Supabase is not configured (the same condition under which MemoryRepo serves shopper reads).
// State lives on globalThis so every route handler in the dev/prod server process sees the same data.
// It is NOT durable: it resets when the server restarts. The UI keeps its "Demo action" labels for this reason.
// Server-only: never import this from a "use client" component.
import { AISLE_NAMES, DEMO_LOCATIONS, DEMO_PRODUCTS, DEMO_SHELVES, DEMO_STORE } from "../seed/demo-store";
import { DEMO_OTHER_REVIEWER, SEED_AUDIT, SEED_OBSERVATIONS } from "../seed/demo-review";
import { cloneMap, demoFloorPlan, mapChecks } from "../map/graph";
import { candStr, fmt, locLong, locLongOf, norm, shelfOf, STATUS_TXT } from "../review/format";
import { validate } from "../review/validate";
import type {
  AuditEvent, FloorPlan, Observation, ObservationCandidate, PublishedProduct, ReviewAction, ReviewDraft, ShelfLevel, StaffMember, StoreMaps,
} from "../types";

interface DemoDB {
  products: PublishedProduct[];
  observations: Observation[];
  audit: AuditEvent[];
  maps: StoreMaps;
  seq: number;
}

function seedProducts(): PublishedProduct[] {
  const shelves = new Map(DEMO_SHELVES.map((s) => [s.id, s]));
  return DEMO_PRODUCTS.flatMap((p) => {
    const location = DEMO_LOCATIONS.find((l) => l.productId === p.id);
    const shelf = location && shelves.get(location.shelfId);
    return location && shelf ? [{ ...p, aliases: [...p.aliases], location: { ...location }, shelf: { id: shelf.id, aisle: shelf.aisle, section: shelf.section } }] : [];
  });
}

function initial(): DemoDB {
  return {
    products: seedProducts(),
    observations: SEED_OBSERVATIONS.map((o) => ({ ...o, candidate: { ...o.candidate } })),
    audit: SEED_AUDIT.map((e) => ({ ...e })),
    maps: { published: demoFloorPlan(), draft: null, draftSavedAt: null },
    seq: 0,
  };
}

const G = globalThis as unknown as { __storeguideDemo?: DemoDB };
export function db(): DemoDB {
  return (G.__storeguideDemo ??= initial());
}
export function resetDemo(): void {
  G.__storeguideDemo = initial();
}

const nextEventId = () => `e${Date.now()}-${++db().seq}`;
const actorText = (a: StaffMember) => `${a.label} · ${a.id}`;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ───────────────────────────── Reads ─────────────────────────────

export const listProducts = (storeId: string) => clone(db().products.filter((p) => p.storeId === storeId));
export const listObservations = (storeId: string) => clone(db().observations.filter((o) => o.storeId === storeId));
export const listAudit = (storeId: string) => (storeId === DEMO_STORE.id ? clone(db().audit) : []);
export const getMaps = (storeId: string): StoreMaps | null => (storeId === DEMO_STORE.id ? clone(db().maps) : null);

// ───────────────────────────── Results ─────────────────────────────

export type Fail = { ok: false; status: 403 | 404 | 409 | 422 | 500; code: string; error: string; failing?: string[] };
export type Ok<T> = { ok: true } & T;

// ───────────────────────────── Review ─────────────────────────────

export interface ReviewRequest {
  action: ReviewAction;
  observationId: string;
  obsVersion: number;
  draft?: ReviewDraft;
  targetVersion?: number | null;
  reason?: string;
}

export type ReviewResult = Ok<{ observation: Observation; product?: PublishedProduct; isNew?: boolean; event: AuditEvent }> | Fail;

/**
 * Server contract, in order, all-or-nothing:
 * authorized → still NEEDS_REVIEW → observation version → validate() → merge target version → one write.
 * The caller (route) has already checked staff auth for the observation's store.
 */
export function reviewObservation(req: ReviewRequest, actor: StaffMember): ReviewResult {
  const state = db();
  const o0 = state.observations.find((x) => x.id === req.observationId);
  if (!o0) return { ok: false, status: 404, code: "NOT_FOUND", error: "Observation not found." };
  if (!actor.canPublish || !actor.stores.includes(o0.storeId)) {
    return { ok: false, status: 403, code: "FORBIDDEN", error: "You are not authorized to review observations for this store." };
  }

  // Demo concurrency: another employee's approval lands first (see DEMO_OTHER_REVIEWER).
  const other = DEMO_OTHER_REVIEWER[o0.id];
  if (other && o0.status === "NEEDS_REVIEW") {
    const idx = state.observations.indexOf(o0);
    state.observations[idx] = { ...o0, status: "ACCEPTED", reviewedBy: other.by, reviewedById: other.byId, reviewedAt: other.at, version: o0.version + 1 };
  }
  const o = state.observations.find((x) => x.id === req.observationId)!;

  if (o.status !== "NEEDS_REVIEW") {
    return {
      ok: false, status: 409, code: "ALREADY_REVIEWED",
      error: `This observation is already ${STATUS_TXT[o.status].toLowerCase()}${o.reviewedBy ? " by " + o.reviewedBy : ""}. It cannot be reviewed again.`,
    };
  }
  if (o.version !== req.obsVersion) {
    return { ok: false, status: 409, code: "CONFLICT", error: "This observation changed since you opened it. Go back to the queue and review it again." };
  }

  const at = new Date().toISOString();
  const actorLabel = actorText(actor);

  if (req.action === "reject" || req.action === "rescan") {
    const reason = (req.reason || "").trim();
    if (reason.length < 5) return { ok: false, status: 422, code: "INVALID", error: "A reason of at least 5 characters is required.", failing: ["reason"] };
    const status = req.action === "reject" ? "REJECTED" : "NEEDS_RESCAN";
    const observation: Observation = { ...o, status, reviewedBy: actorLabel, reviewedById: actor.id, reviewedAt: at, reason, version: o.version + 1 };
    const event: AuditEvent = {
      id: nextEventId(), actor_label: actorLabel, action: req.action, entity: "observation", entity_id: o.id, created_at: at,
      summary: `${o.id} ${req.action === "reject" ? "rejected" : "sent back for rescan"}`,
      old_json: { display: STATUS_TXT.NEEDS_REVIEW, status: "NEEDS_REVIEW" }, new_json: { display: `${status}: ${reason}`, status, reason },
      evidence: o.evidence, original_observation: candStr(o.candidate),
    };
    // Single commit point.
    state.observations = state.observations.map((x) => (x.id === o.id ? observation : x));
    state.audit = [event, ...state.audit];
    return { ok: true, observation: clone(observation), event: clone(event) };
  }

  const d = req.draft;
  if (!d) return { ok: false, status: 422, code: "INVALID", error: "Review details are required to publish.", failing: ["draft"] };
  const fails = validate(o, d, state.products, state.maps.published).filter((c) => !c.ok);
  if (fails.length) {
    return {
      ok: false, status: 422, code: "INVALID",
      error: "Server validation failed: " + fails.map((f) => f.label.toLowerCase()).join("; ") + ".", failing: fails.map((f) => f.label),
    };
  }

  const shelf = shelfOf(d.shelf)!;
  const fields = {
    name: d.name.trim(), brand: d.brand.trim() || null, category: d.category, size: d.size.trim() || null, variant: d.variant.trim() || null,
  };
  const location = { shelfId: d.shelf, level: d.level as ShelfLevel, verifiedAt: at, verifiedBy: actor.label };
  const isNew = d.match === "new";
  let product: PublishedProduct;
  let oldTxt: string;
  let oldJson: Record<string, unknown> = {};

  if (isNew) {
    const n = Math.max(0, ...state.products.map((p) => Number(p.id.slice(1)) || 0)) + 1;
    const id = "P" + String(n).padStart(2, "0");
    product = {
      id, storeId: o.storeId, ...fields, aliases: [norm(fields.name)], version: 1,
      location: { productId: id, ...location }, shelf: { id: shelf.id, aisle: shelf.aisle, section: shelf.section },
    };
    oldTxt = "— (new product)";
  } else {
    const t = state.products.find((p) => p.id === d.match)!;
    if ((t.version ?? 1) !== req.targetVersion) {
      return { ok: false, status: 409, code: "TARGET_CONFLICT", error: `${t.name} was changed by another employee after you selected it. Review the current record and confirm again.` };
    }
    oldTxt = `${[t.brand, t.name, t.size].filter(Boolean).join(" ")} · ${locLong(t)}`;
    oldJson = { product_id: t.id, shelf_id: t.location.shelfId, level: t.location.level, version: t.version ?? 1 };
    product = {
      ...t, ...fields, aliases: [...new Set([...t.aliases, norm(fields.name)])], version: (t.version ?? 1) + 1,
      location: { productId: t.id, ...location }, shelf: { id: shelf.id, aisle: shelf.aisle, section: shelf.section },
    };
  }

  const edited = (["name", "brand", "category", "size", "variant", "shelf", "level"] as const).some((k) => (o.candidate[k] || "") !== (d[k] || ""));
  const status = edited ? "EDITED" : "ACCEPTED";
  const observation: Observation = {
    ...o, status, reviewedBy: actorLabel, reviewedById: actor.id, reviewedAt: at, productId: product.id, isNew, version: o.version + 1, saved: undefined,
  };
  const event: AuditEvent = {
    id: nextEventId(), actor_label: actorLabel, action: "approve", entity: "product", entity_id: product.id, created_at: at,
    summary: `${product.name} ${isNew ? "added" : "verified"} at Aisle ${shelf.aisle}, Section ${shelf.section} (${o.id})`,
    old_json: { display: oldTxt, ...oldJson },
    new_json: { display: `${[product.brand, product.name, product.size].filter(Boolean).join(" ")} · ${locLong(product)}`, product_id: product.id, shelf_id: product.location.shelfId, level: product.location.level, version: product.version, status },
    evidence: o.evidence, original_observation: candStr(o.candidate),
  };

  // Single commit point: product + location (move_product equivalent), observation status and audit together.
  state.products = isNew ? [...state.products, product] : state.products.map((p) => (p.id === product.id ? product : p));
  state.observations = state.observations.map((x) => (x.id === o.id ? observation : x));
  state.audit = [event, ...state.audit];
  return { ok: true, observation: clone(observation), product: clone(product), isNew, event: clone(event) };
}

/** "Save details": store the employee's corrections on the observation without publishing. */
export function saveDraft(id: string, draft: ReviewDraft, actor: StaffMember): Ok<{ observation: Observation }> | Fail {
  const state = db();
  const o = state.observations.find((x) => x.id === id);
  if (!o) return { ok: false, status: 404, code: "NOT_FOUND", error: "Observation not found." };
  if (!actor.stores.includes(o.storeId)) return { ok: false, status: 403, code: "FORBIDDEN", error: "You are not authorized for this store." };
  if (o.status !== "NEEDS_REVIEW") return { ok: false, status: 409, code: "ALREADY_REVIEWED", error: `This observation is already ${STATUS_TXT[o.status].toLowerCase()}.` };
  const observation = { ...o, saved: { ...draft, idReset: false, locReset: false } };
  state.observations = state.observations.map((x) => (x.id === id ? observation : x));
  return { ok: true, observation: clone(observation) };
}

// ───────────────────────────── Shopper observations ─────────────────────────────

export interface ShopperSubmission {
  storeId: string;
  confidence: Observation["confidence"];
  evidence: string;
  candidate: ObservationCandidate;
}

/** A consented shopper submission. Matching pending observations (same brand+name+shelf) gain a sighting instead. */
export function submitShopperObservation(s: ShopperSubmission): Ok<{ observation: Observation; merged: boolean; message: string }> | Fail {
  const state = db();
  if (s.storeId !== DEMO_STORE.id) return { ok: false, status: 404, code: "NOT_FOUND", error: "Unknown store." };
  const now = new Date().toISOString();
  const keyOf = (c: ObservationCandidate) => norm(`${c.brand || ""} ${c.name}`) + "|" + c.shelf;
  const ex = state.observations.find((o) => o.storeId === s.storeId && o.status === "NEEDS_REVIEW" && keyOf(o.candidate) === keyOf(s.candidate));
  let observation: Observation;
  if (ex) {
    const n = (ex.sightings || 1) + 1;
    observation = { ...ex, sightings: n, evidence: `${n} shopper sightings, latest ${fmt(now)}. ${s.evidence}` };
    state.observations = state.observations.map((o) => (o.id === ex.id ? observation : o));
  } else {
    const n = Math.max(100, ...state.observations.map((o) => Number(o.id.replace("OBS-", "")) || 0)) + 1;
    observation = {
      id: `OBS-${n}`, source: "shopper", storeId: s.storeId, at: now, confidence: s.confidence, evidence: `1 shopper sighting. ${s.evidence}`,
      candidate: { ...s.candidate }, status: "NEEDS_REVIEW", version: 1, sightings: 1,
    };
    state.observations = [...state.observations, observation];
  }
  const event: AuditEvent = {
    id: nextEventId(), actor_label: "Shopper (anonymous, consented)", action: "ai", entity: "observation", entity_id: observation.id, created_at: now,
    summary: ex ? `Another shopper sighting added to ${observation.id}` : `Shopper observation ${observation.id} submitted for review`,
    old_json: { display: "—" }, new_json: { display: "NEEDS_REVIEW · not published", status: "NEEDS_REVIEW" },
    evidence: "Structured text only (demo). No image or video uploaded.", original_observation: null,
  };
  state.audit = [event, ...state.audit];
  const message = ex
    ? `Added as another sighting of ${observation.id}, which is already waiting for staff review. No duplicate was created.`
    : `Sent as ${observation.id}. A store employee will review it. It is not used for search or directions until approved.`;
  return { ok: true, observation: clone(observation), merged: !!ex, message };
}

// ───────────────────────────── Product move ─────────────────────────────

/** Equivalent of move_product(): supersede the location, bump version, write audit, in one commit. */
export function moveProduct(
  productId: string, shelfId: string, level: ShelfLevel, expectedVersion: number | undefined, actor: StaffMember,
): Ok<{ product: PublishedProduct; event: AuditEvent }> | Fail {
  const state = db();
  const p = state.products.find((x) => x.id === productId);
  if (!p) return { ok: false, status: 404, code: "NOT_FOUND", error: "Product not found." };
  if (!actor.canPublish || !actor.stores.includes(p.storeId)) return { ok: false, status: 403, code: "FORBIDDEN", error: "You are not authorized to publish for this store." };
  const shelf = shelfOf(shelfId);
  if (!shelf || shelf.storeId !== p.storeId) return { ok: false, status: 422, code: "INVALID", error: "That shelf is not in this store.", failing: ["shelf_id"] };
  if (!state.maps.published.shelves.some((r) => r.id === shelfId && r.anchor)) {
    return { ok: false, status: 422, code: "INVALID", error: `${shelfId} is not placed on the published floor plan.`, failing: ["shelf_id"] };
  }
  if (expectedVersion !== undefined && (p.version ?? 1) !== expectedVersion) {
    return { ok: false, status: 409, code: "CONFLICT", error: `${p.name} was changed by another employee. Reopen it and try again.` };
  }
  const at = new Date().toISOString();
  const product: PublishedProduct = {
    ...p, version: (p.version ?? 1) + 1,
    location: { productId: p.id, shelfId, level, verifiedAt: at, verifiedBy: actor.label },
    shelf: { id: shelf.id, aisle: shelf.aisle, section: shelf.section },
  };
  const event: AuditEvent = {
    id: nextEventId(), actor_label: actorText(actor), action: "move", entity: "product", entity_id: p.id, created_at: at,
    summary: `${p.name} moved to Aisle ${shelf.aisle}, Section ${shelf.section}`,
    old_json: { display: locLong(p), shelf_id: p.location.shelfId, level: p.location.level },
    new_json: { display: locLongOf(product.location), shelf_id: shelfId, level },
    evidence: "No new photo (manual edit)", original_observation: null,
  };
  state.products = state.products.map((x) => (x.id === p.id ? product : x));
  state.audit = [event, ...state.audit];
  return { ok: true, product: clone(product), event: clone(event) };
}

// ───────────────────────────── Floor plan ─────────────────────────────

export function saveMapDraft(mapId: string, draft: FloorPlan, actor: StaffMember): Ok<{ maps: StoreMaps }> | Fail {
  const state = db();
  if (!actor.stores.includes(DEMO_STORE.id)) return { ok: false, status: 403, code: "FORBIDDEN", error: "You are not authorized for this store." };
  if (mapId !== state.maps.published.mapId) return { ok: false, status: 404, code: "NOT_FOUND", error: "Map not found." };
  state.maps = { ...state.maps, draft: { ...cloneMap(draft), mapId, version: state.maps.published.version }, draftSavedAt: new Date().toISOString() };
  return { ok: true, maps: clone(state.maps) };
}

export function publishMap(mapId: string, actor: StaffMember): Ok<{ maps: StoreMaps; event: AuditEvent }> | Fail {
  const state = db();
  if (!actor.canPublish || !actor.stores.includes(DEMO_STORE.id)) return { ok: false, status: 403, code: "FORBIDDEN", error: "You are not authorized to publish for this store." };
  const old = state.maps.published;
  if (mapId !== old.mapId) return { ok: false, status: 404, code: "NOT_FOUND", error: "Map not found." };
  const d = state.maps.draft;
  if (!d) return { ok: false, status: 422, code: "INVALID", error: "Save a draft before publishing." };
  const fails = mapChecks(d, state.products).filter((c) => !c.ok);
  if (fails.length) return { ok: false, status: 422, code: "INVALID", error: "The draft does not pass the publish checklist.", failing: fails.map((f) => f.label) };
  const v = old.version + 1;
  const at = new Date().toISOString();
  const event: AuditEvent = {
    id: nextEventId(), actor_label: actorText(actor), action: "map", entity: "store_map", entity_id: old.mapId, created_at: at,
    summary: `Floor plan v${v} published`,
    old_json: { display: `v${old.version} · ${old.plan ? old.plan.name : "Demo floor plan"}`, version: old.version },
    new_json: { display: `v${v} · ${d.plan ? d.plan.name : "Demo floor plan"} · ${d.shelves.length} shelves, ${d.nodes.length} points, ${d.edges.length} walkable connections`, version: v },
    evidence: d.plan ? d.plan.name : "Demo floor plan", original_observation: null,
  };
  state.maps = { published: { ...cloneMap(d), version: v }, draft: null, draftSavedAt: null };
  state.audit = [event, ...state.audit];
  return { ok: true, maps: clone(state.maps), event: clone(event) };
}

export const aisleName = (aisle: string) => AISLE_NAMES[aisle] ?? "";
