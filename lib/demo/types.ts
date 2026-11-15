// Shapes returned by the demo adapter (lib/demo/adapter.ts). Safe to import on the client.
import type { AuditEvent, Observation, PublishedProduct, StoreMaps } from "../types";

export interface StaffSnapshot {
  storeId: string;
  storeName: string;
  staff: { id: string; label: string };
  products: PublishedProduct[];
  observations: Observation[];
  audit: AuditEvent[];
  maps: StoreMaps;
}

/** Same error shape as the API contract: HTTP-like status, machine code, human message, failing checklist labels. */
export interface DemoFail {
  ok: false;
  status: number;
  code: string;
  error: string;
  failing?: string[];
  snapshot?: StaffSnapshot;
}

export type DemoResult<T> = ({ ok: true } & T) | DemoFail;
