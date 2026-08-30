import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Some flows read raw assets at runtime via fs (the repo-init README
  // template; the agent-library starter YAML files). Next.js's tracing won't
  // include raw assets by default, so opt them in here for the standalone build.
  outputFileTracingIncludes: {
    "*": [
      "./node_modules/@swc/helpers/**/*",
      "./src/lib/templates/**/*.md",
      "./src/lib/agent-library/**/*.yaml",
    ],
  },
};

export default nextConfig;
