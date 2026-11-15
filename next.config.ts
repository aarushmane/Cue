import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  cacheComponents: true,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // LangChain / deepagents use Node-only optional deps (e.g. `ws` in langsmith); load them with native require.
  serverExternalPackages: ["deepagents", "langchain", "langsmith", "@langchain/core", "@langchain/anthropic", "@langchain/google-genai", "@langchain/langgraph"],
  partialPrefetching: true,
  // Tailwind runs through postcss.config.mjs (@tailwindcss/postcss) for every stylesheet; a second
  // Turbopack Tailwind loader would process CSS twice.
};

export default nextConfig;
