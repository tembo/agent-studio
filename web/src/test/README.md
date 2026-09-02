# Test setup

Three layers, each with its own runner and config:

- **Unit + integration** — Vitest. Co-located `.test.ts` files next to
  the code they cover. `pnpm test` runs the whole suite.
- **HTTP recording** — Polly.js cassettes under `cassettes/`, replayed
  by default. Set `POLLY_RECORD=1 pnpm test` to re-record.
- **End-to-end (BDD)** — Cucumber.js + Playwright. `pnpm test:bdd`
  runs `.feature` files against the dev server.

**First-time setup:** `pnpm test:bdd:install` downloads the Chromium
build Playwright drives (~150MB) and any required system libraries.
Skip on subsequent installs unless the Playwright version bumps.

**Dev server must be running** in another terminal before
`pnpm test:bdd` — the suite drives a real browser against
http://localhost:3000 by default (override with TAS_TEST_BASE_URL).
Set HEADLESS=0 to watch the browser drive the test in real time.

## Cassette workflow

Cassettes live in `src/test/cassettes/<cassette-name>_<n>.har` and are
committed to git. To add a new one:

1. Write the test using `usePolly("my-cassette-name")` from
   `@/test/polly`.
2. Run once with `POLLY_RECORD=1 pnpm test -- <pattern>` to hit the
   real service and capture the response.
3. Inspect the resulting `.har` file — scrub any auth tokens before
   committing. The persister stores headers verbatim by default.
4. Subsequent runs replay from disk; CI never touches the network.

If a request has no recording and the mode is `replay`, the test
fails loud rather than silently fetching live data — this is the
whole point of recording, so we keep the safety on.

## When to use what

- **No HTTP involved** → plain Vitest test, mock dependencies with
  `vi.mock` (see `lib/auth-server.test.ts`).
- **One outbound HTTP call** → Polly with a recorded cassette.
- **Multi-page user flow** → Cucumber feature + Playwright.

## Microsoft / OIDC sign-in

Most of the Microsoft Entra ID and generic OIDC sign-in contract is
testable without a live IdP: provider discovery/client config, redirect
URI construction, profile email/name mapping, and the sign-up-policy
`user.create.before` / invite-resolution hooks are covered by Vitest
with mocked better-auth boundaries.

A live Microsoft/Okta/Auth0/Keycloak app is only needed for final smoke
coverage of the provider-owned surfaces: tenant/app registration,
consent/login UI, and the real authorization-code/token exchange. CI
should use mocks for deterministic coverage; run the live IdP smoke test
manually when changing provider env or before declaring a deployment's
external IdP setup verified.

## Server-only shim

Most `lib/*.ts` files start with `import "server-only"`, which throws
in the Vitest node environment. `setup.ts` stubs the module so
production code can be imported as-is.
