// Pure selectors over the staff snapshot, shared by manager screens.
import { fmt } from "@/lib/review/format";
import type { StaffSnapshot } from "@/lib/demo/types";
import type { AuditEvent, AuditKind } from "@/lib/types";

export const productsAt = (s: StaffSnapshot, shelfId: string) => s.products.filter((p) => p.location.shelfId === shelfId);
export const pendingObs = (s: StaffSnapshot) => s.observations.filter((o) => o.status === "NEEDS_REVIEW");
export const pendingAt = (s: StaffSnapshot, shelfId: string) => pendingObs(s).filter((o) => o.candidate.shelf === shelfId);
export const reviewedObs = (s: StaffSnapshot) =>
  s.observations.filter((o) => o.status !== "NEEDS_REVIEW").sort((a, b) => (b.reviewedAt || "").localeCompare(a.reviewedAt || ""));

export const dotFor = (k: AuditKind) => (k === "ai" ? "#E8B84B" : k === "map" || k === "reject" || k === "rescan" ? "#252331" : "#44337A");

export const eventRow = (e: AuditEvent) => ({ ...e, when: fmt(e.created_at), dot: dotFor(e.action) });

export const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
