import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  // Lets the Supabase-mode e2e server (playwright.auth.config.ts) build into its own directory.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // LangChain / deepagents use Node-only optional deps (e.g. `ws` in langsmith); load them with native require.
  serverExternalPackages: ["deepagents", "langchain", "langsmith", "@langchain/core", "@langchain/anthropic", "@langchain/google-genai", "@langchain/langgraph"],
  partialPrefetching: true,
  // The shopper-sightings review moved into the manager app.
  async redirects() {
    return [{ source: "/staff/inventory", destination: "/business/sightings", permanent: false }];
  },
  // Tailwind runs through postcss.config.mjs (@tailwindcss/postcss) for every stylesheet; a second
  // Turbopack Tailwind loader would process CSS twice.
};

export default nextConfig;
