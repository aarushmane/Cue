// Default e2e ports, derived from this checkout's path. Several worktrees of this repo run e2e side by side; with one
// fixed port, Playwright would find another worktree's dev server already listening and test THAT code instead.
// Each checkout gets its own block of 3 ports in 3100–5499 (memory-mode app, Supabase-mode app, stub Supabase).
// E2E_PORT overrides the base. Servers are never reused unless PW_REUSE_SERVER=1, so a busy port fails loudly.
import { createHash } from "node:crypto";

const hash = parseInt(createHash("sha1").update(process.cwd()).digest("hex").slice(0, 8), 16);
export const BASE_PORT = Number(process.env.E2E_PORT ?? 3100 + (hash % 800) * 3);
export const REUSE_SERVER = process.env.PW_REUSE_SERVER === "1";
