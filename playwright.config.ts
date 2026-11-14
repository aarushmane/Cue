import { defineConfig, devices } from "@playwright/test";
import { BASE_PORT, REUSE_SERVER } from "./tests/e2e-ports";

// E2E for the v4 handoff scenarios. The demo backend is one in-memory store per server process, so tests run
// serially and each starts by resetting demo data. Supabase-mode sign-in tests: playwright.auth.config.ts.
const PORT = BASE_PORT;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices["Desktop Chrome"],
    // Set PW_CHANNEL=chrome to use an installed Google Chrome instead of Playwright's bundled browser.
    channel: process.env.PW_CHANNEL || undefined,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/shopper`,
    reuseExistingServer: REUSE_SERVER,
    timeout: 120_000,
    env: { NEXT_PUBLIC_SUPABASE_URL: "", NEXT_PUBLIC_SUPABASE_ANON_KEY: "" },
  },
});
