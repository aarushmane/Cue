import { defineConfig, devices } from "@playwright/test";
import { BASE_PORT, REUSE_SERVER } from "./tests/e2e-ports";

// Supabase-mode e2e: staff sign-in, session cookies, refresh and sign-out against a stub Supabase
// (tests/e2e-auth/stub-supabase.mjs). The app runs from its own build directory (.next-auth) so its inlined
// NEXT_PUBLIC_SUPABASE_URL never mixes with the memory-mode build used by playwright.config.ts.
const PORT = BASE_PORT + 1;
const STUB_PORT = BASE_PORT + 2;

export default defineConfig({
  testDir: "tests/e2e-auth",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices["Desktop Chrome"],
    channel: process.env.PW_CHANNEL || undefined,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    trace: "retain-on-failure",
  },
  metadata: { stubUrl: `http://localhost:${STUB_PORT}` },
  webServer: [
    {
      command: "node tests/e2e-auth/stub-supabase.mjs",
      url: `http://localhost:${STUB_PORT}/__stats`,
      reuseExistingServer: REUSE_SERVER,
      env: { STUB_PORT: String(STUB_PORT) },
    },
    {
      command: `npx next dev -p ${PORT}`,
      url: `http://localhost:${PORT}/shopper`,
      reuseExistingServer: REUSE_SERVER,
      timeout: 120_000,
      env: {
        NEXT_DIST_DIR: ".next-auth",
        NEXT_PUBLIC_SUPABASE_URL: `http://localhost:${STUB_PORT}`,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "stub-anon-key",
        SUPABASE_SERVICE_ROLE_KEY: "stub-service-role-key",
      },
    },
  ],
});
