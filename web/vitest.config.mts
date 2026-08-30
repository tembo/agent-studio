import { defineConfig } from "vitest/config";

// Vitest is the unit + integration test runner for the web app.
// We intentionally keep Playwright (browser BDD) and Polly.js (HTTP
// recording) in separate configs so unit tests stay fast — `pnpm
// test` should never take more than a few seconds on a laptop.
//
// `resolve.tsconfigPaths` picks up the `@/* -> src/*` alias from
// tsconfig.json so test files import the same way production code
// does. No second source of truth for path aliases.
//
// The `node` environment is the default because most of what we
// test is server-only (lib/, server actions). JSDOM gets opted into
// per-test when needed via `// @vitest-environment jsdom` headers.

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    // Auto-collect tests from co-located .test.ts files. Putting
    // tests next to the code they cover keeps the import graph
    // honest and makes it obvious when a module loses coverage.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // server-only imports throw at module-evaluation time outside
    // of a real Next.js request — we shim it to a no-op so the
    // modules under test still load. The shim's harmless because
    // we never actually execute the production runtime guard.
    setupFiles: ["./src/test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // Exclude infra + UI-only files where unit tests have low
      // ROI; cover the lib/ surface where the real logic lives.
      include: ["src/lib/**/*.ts"],
      exclude: ["src/lib/**/*.test.ts"],
    },
  },
});
