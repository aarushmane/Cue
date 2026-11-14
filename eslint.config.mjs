import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    // Build output of the Supabase-mode e2e server (playwright.auth.config.ts, NEXT_DIST_DIR).
    ".next-auth/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Claude Design prototype (reference only, not app code).
    "design-handoff/**",
  ]),
]);

export default eslintConfig;
