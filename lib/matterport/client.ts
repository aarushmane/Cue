import "server-only";

// Shared Matterport Model API transport. Credentials stay on the server.
const API = "https://api.matterport.com/api/models/graph";

export class MatterportError extends Error {}

export function matterportConfigured(): boolean {
  return Boolean(process.env.MATTERPORT_API_KEY && process.env.MATTERPORT_API_TOKEN);
}

export async function graph<T = Record<string, unknown>>(query: string, variables: Record<string, unknown>): Promise<T> {
  const auth = Buffer.from(`${process.env.MATTERPORT_API_KEY}:${process.env.MATTERPORT_API_TOKEN}`).toString("base64");
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 401 || res.status === 403) throw new MatterportError(`Matterport rejected the key (HTTP ${res.status}). Check MATTERPORT_API_KEY / MATTERPORT_API_TOKEN.`);
  if (!res.ok) throw new MatterportError(`Matterport API HTTP ${res.status}`);
  const body = (await res.json()) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
  const err = body.errors?.[0];
  if (err) {
    if (err.extensions?.code === "not.found") throw new MatterportError("not.found");
    throw new MatterportError(`GraphQL error: ${err.message}`);
  }
  return body.data as T;
}
