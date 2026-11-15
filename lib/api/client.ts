// Client-side result shape for the JSON API routes. Screens already handle `{ ok, status, code, error, failing }`
// (the shape the demo adapter used, which mirrors the API contract), so route calls are converted to it here.
// Safe to import on the client.

export interface ApiFail {
  ok: false;
  status: number;
  code: string;
  error: string;
  failing?: string[];
}
export type ApiResult<T> = ({ ok: true } & T) | ApiFail;

const FALLBACK: Record<number, string> = {
  400: "The request was malformed. Nothing was changed.",
  401: "Sign in as store staff. Nothing was changed.",
  403: "You are not authorized for this store. Nothing was changed.",
  404: "That item no longer exists. Nothing was changed.",
};

/** Await a fetch() and normalize it: 2xx → { ok: true, ...body }; anything else (or no response) → ApiFail. */
export async function callJson<T extends object>(request: Promise<Response>): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await request;
  } catch {
    return { ok: false, status: 0, code: "NETWORK", error: "Couldn’t reach StoreGuide. Check your connection. Nothing was changed. You can try again." };
  }
  const body = (await res.json().catch(() => null)) as (Record<string, unknown> & Partial<ApiFail>) | null;
  if (res.ok) return { ok: true, ...(body as T) };
  return {
    ok: false,
    status: res.status,
    code: typeof body?.code === "string" ? body.code : "FAILED",
    error:
      typeof body?.error === "string"
        ? body.error
        : (FALLBACK[res.status] ?? "The request did not complete. Nothing was changed. You can try again."),
    ...(Array.isArray(body?.failing) ? { failing: body.failing as string[] } : {}),
  };
}

export const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
