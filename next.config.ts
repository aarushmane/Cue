import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // LangChain / deepagents use Node-only optional deps (e.g. `ws` in langsmith); load them with native require.
  serverExternalPackages: ["deepagents", "langchain", "langsmith", "@langchain/core", "@langchain/anthropic", "@langchain/google-genai", "@langchain/langgraph"],
  partialPrefetching: true,
  // The shopper-sightings review moved into the manager app.
  async redirects() {
    return [{ source: "/staff/inventory", destination: "/business/sightings", permanent: false }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
