# Changelog

All notable changes to Tembo Agent Studio. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

**Versioning:** releases use a year.month [CalVer](https://calver.org/) tag plus
a release counter — `vYYYY.M.N`. `YYYY.M` is the year and month; `N` increments
once per release within that month and is **not** the day of the month (the
earliest 2026 tags happened to line up with the date, but it's just a counter).
The `0.1`–`0.4` entries below are phase numbers from
[`ROADMAP.md`](./ROADMAP.md), which remain the *construction* milestones;
they are no longer release versions. Phase scope now lives in
[GitHub Issues](https://github.com/tembo/agent-studio/issues?q=is%3Aissue+label%3Aenhancement).

## [Unreleased]

### Added
- **Per-user OAuth for the TAS MCP server.** Claude Web, Claude Desktop, and
  other hosted MCP clients can now discover TAS OAuth metadata, register
  dynamically, complete S256 PKCE, select a workspace, and receive refreshable
  tokens bound to the signed-in user's live membership and role. Existing
  `tas_` API keys remain
  supported for Claude Code and scripts.
- **Durable Pydantic runs.** Pydantic executions now persist their immutable
  launch envelope and checkpoint typed message history at every model/tool node.
  Runs interrupted by an API or host restart resume from the last acknowledged
  checkpoint, preserve the original run clock and completed-step usage, and
  show a **Resumed** indicator on run detail. Cargo AI and legacy runs remain
  explicit interruption failures because they have no safe replay boundary.

### Fixed

- **Claude showed the Railway logo for the TAS connector.** The MCP initialize
  response now advertises Tembo's display name and a public PNG icon, the icon
  directory bypasses the session gate, and `/favicon.ico` provides a fallback
  for clients that use conventional origin favicon discovery.

## [v2026.8.1] — Password management for email/password instances, in-app instance admins, personal Tembo identity — shipped 2026-08-04

### Added
- **Lost / reset / change password on email/password instances.** TAS is
  SMTP-free, so recovery is admin-driven: a workspace admin generates a
  one-time reset link (1-hour expiry) from the member's detail page and
  shares it out-of-band; the link lands on a new public `/reset-password`
  page. Signed-in users change their own password under Settings →
  Account. Both revoke other sessions. None of this renders when an OAuth
  provider is configured — credentials live at the identity provider there.
- **Instance admins managed in-app.** Instance Settings now lists and edits
  instance admins (stored in the database, unioned with the
  `INSTANCE_ADMIN_EMAILS` env bootstrap); the sign-up gate honors both
  sources, so admin changes no longer require a redeploy.
- **Personal Tembo identity with workspace fallback.** Chat-to-PR authoring
  can use a per-user Tembo API key (Settings → Tembo), falling back to the
  workspace key — PRs and sessions attribute to the person, not the shared
  workspace identity.
- **Built-in run date/time tool.** Every Pydantic agent can call
  `get_run_datetime` without adding a connection. It returns the stable run-start
  instant and local date/time fields for a requested IANA timezone, giving
  scheduled agents a reliable basis for relative windows and date-based dedup.

### Fixed
- **Invitations now resolve on email/password instances.** Credential
  sign-ups always carry `emailVerified=false` (no IdP, no SMTP), and the
  invite-to-membership step required a verified email — so invitees could
  sign up but landed workspace-less. On email/password instances the
  invite-gated sign-up itself is the authorization, and invites now resolve;
  instances with an OAuth provider keep the strict IdP-verified check.

### Changed
- **Continuous deploys now cover all Tembo-managed instances.** The internal
  pipeline that tracked `main` on the dogfood box now fans out per-instance
  (each with its own Railway project token) — self-hosted customer
  instances remain pinned to release tags like this one.

## [v2026.7.4] — Inbox reading view for digests, markdown context + run links, quieter Slack threads — shipped 2026-07-24

### Added
- **Inbox item detail: markdown context + run link.** Context fields that
  contain Markdown (agent digests) now render formatted instead of as raw
  text, and the header links to the run that produced the item.
- **Newsletter-style reading view for text-only inbox items.** Any text-only
  context (the `{ text }` shape `produce_inbox_item` stores for plain-string
  contexts) now renders as an unboxed full-width document at reading size
  (18px/1.6) with no CONTEXT/TEXT chrome — the markdown sniff only picks the
  renderer (Markdown vs pre-wrap), so table-only markdown can no longer fall
  back to the boxed fields view. GFM tables are recognized and wide tables
  scroll horizontally. Structured contexts keep the boxed labeled-fields view.
- **Links rollup on inbox items.** The Links section moves below the content
  and collapses behind a "Links (N)" disclosure past 5 entries, so a digest
  citing 20 sources no longer opens with a wall of links while short triage
  lists stay fully visible. `produce_inbox_item`'s descriptions now steer
  producers to inline markdown sources for narrative digests.

### Fixed
- **Slack: untagged thread replies no longer trigger the which-agent menu.**
  A plain reply inside a bot DM thread (e.g. answering a daily brief with
  `Y`) used to post the "Tell me which agent to run…" menu on top of any
  custom listener already answering that thread. Untagged thread replies are
  now left to the thread's listener; explicit `@agent` mentions in a thread
  still launch their agent, and plain top-level DMs are unchanged.
- **Internal deploy CI: Railway GraphQL errors now fail the job.** Railway
  reports failures in-band with HTTP 200, so `curl -f` never tripped — an
  expired plan left the deploy step green while deploying nothing.

## [v2026.7.3] — pydantic-ai 2.x runner, WebSearch run + agent-change dispatch fixes, catalog batch 3 — shipped 2026-07-20

### Added
- **Native MCP catalog batch 3: 136 more providers.** Harvested from the
  official MCP registry (54k entries swept), the claude.com/connectors
  directory, and community remote-MCP lists; every endpoint live-probed
  (MCP `initialize` → `/.well-known/oauth-protected-resource` →
  auth-server metadata → `registration_endpoint`) on 2026-07-18:
  - **TAS-managed DCR (123):** sales/GTM (Outreach, Salesloft, ZoomInfo,
    Lusha, Hunter, Instantly, Crossbeam, Harmonic, Chili Piper, Day AI,
    Clarify, Staircase AI), support/CX (Zendesk, Help Scout, Gorgias, Plain,
    Lorikeet, Unthread, Enterpret, Dovetail, Missive), meetings (Otter.ai,
    Grain, Krisp, Circleback, tl;dv), finance (Ramp, Brex, Mercury,
    Expensify, Navan, Carta, Digits, GoCardless, Mercado Pago), market
    intelligence (PitchBook, Morningstar, CB Insights, Quartr, Daloopa,
    Consensus), HR/recruiting (Gusto, Deel, Ashby, Workable, Metaview,
    Indeed, Udemy Business), compliance/e-sign (Vanta, Drata, SignNow),
    productivity/design (Figma, Miro, Lucid, Productboard, Aha!, Shortcut,
    Todoist, Teamwork, Calendly, Superhuman Mail, Craft, Mem, Gamma, Pitch,
    Eraser, Jotform, Typeform, SurveyMonkey, Egnyte), marketing/content
    (Mailchimp, Customer.io, Ahrefs, Semrush, Cloudinary, Contentful,
    Sanity, Wix, WordPress.com, GitBook, Mintlify, DeepL), dev/infra
    (GitLab, Supabase, Netlify, Heroku, Buildkite, Grafana, New Relic,
    Honeycomb, incident.io, Rootly, BugSnag, LaunchDarkly, PlanetScale,
    Prisma Postgres, InstantDB, Algolia, Statsig, Postman, Semgrep, WorkOS,
    Stytch, Mux, Knock, Lovable, Retool, Telnyx, Jam, Globalping), data/AI
    (Airbyte, MotherDuck, Monte Carlo, Atlan, Hugging Face), and
    automation/web (Zapier, Make, IFTTT, Exa, Tavily, Firecrawl, Apify,
    Bright Data).
  - **Bring-your-own OAuth app (12):** DocuSign, Xero, Front, Smartsheet,
    MongoDB Atlas, CircleCI, Chargebee, BigQuery (Google manual client,
    like Gmail), Ironclad, Harvey, Tableau, Shopify.
  - **API token (1):** Render (API key as Bearer, like GitHub).
  - Agent Library categories now recognize the new providers, and the
    long-tail **ATS / recruiting**, **HRIS**, **E-signature**, and
    **Survey** categories flip to connectable.
  - Not added (with reasons): per-tenant instance-scoped servers
    (Salesforce, Snowflake, Databricks, ServiceNow, NetSuite, Glean, dbt,
    Elastic…), OAuth `client_credentials`-only (Plaid), unauthenticated /
    docs-only servers, and vendors with no hosted server (Workday,
    Rippling, Okta, Snyk, Perplexity, Loom, Fivetran).

### Fixed
- **WebSearch agent runs on Claude no longer fail with a 400.** Anthropic now
  routinely pauses long server-tool turns (`stop_reason: pause_turn`), which
  pydantic-ai 1.x replayed malformed — every run of a `WebSearch`-capability
  agent died with *"`web_search` tool use … without a corresponding
  `web_search_tool_result` block"* from 2026-07-16 on. The bundled runner is
  now pydantic-ai **2.13.0**, which continues paused turns natively. Also
  drops the sequential-tool-calls default for WebSearch agents on Anthropic
  models (the API rejects `disable_parallel_tool_use` combined with the new
  web_search tool's programmatic tool calling).
- **Agent-change submissions work again.** Tembo CAP renamed its public task
  route from `/public-api/task` to `/public-api/session` (2026-07-16) with no
  alias, so every chat-edit / improve / create dispatch since then failed with
  *"invalid request path"*. TAS now calls the new endpoint.
- **Agent-change dispatch errors are self-describing.** The REST/MCP path
  reported CAP failures as an opaque `(http)`; it now includes the upstream
  HTTP status and response body.

### Changed
- **Runner: pydantic-ai 1.102.0 → 2.13.0.** Spec `instrument: true` and
  ScaleDown compression now attach as pydantic-ai capabilities
  (`Instrumentation` / `ProcessHistory`); behavior is otherwise unchanged.
- **Rust OAuth-origin allowlist is now generated from the web catalog.**
  `api/src/native_oauth_allowlist.rs` is produced from `MCP_PROVIDERS`
  (`web/src/lib/mcp-providers.ts`) by `npm run gen:allowlist`, replacing the
  hand-maintained duplicate (~360 lines of consts + tuples) in
  `native_oauth.rs`. The allowlist-sync vitest is now a staleness check on the
  generated file instead of a per-provider drift detector — the failure mode
  where a catalog entry lands without its Rust twin (the Dialed regression)
  is eliminated rather than just alarmed on. No behavior change: the generated
  table is semantically identical to the old hand list (184 origins).

## [v2026.7.2] — Native MCP catalog expansion, connection search, Zoom, inbox delete — shipped 2026-07-15

### Added
- **Large native MCP catalog expansion.** ~30 more hosted OAuth MCP providers
  verified via live discovery (Anthropic knowledge-work-plugins +
  `/.well-known` probes):
  - **TAS-managed DCR:** PostHog, Stripe, Vercel, Canva, ClickUp, Close, Sentry,
    Mixpanel, Granola, Dropbox, Webflow, Cloudflare, Neon, Cal.com, Klaviyo,
    PayPal, Square, Airtable, Railway, Resend, Hex, Pendo, Similarweb, Datadog,
    Common Room
  - **API token:** GitHub (PAT), X (App-only Bearer)
  - **Bring-your-own OAuth app:** Slack, Gong, Box, PagerDuty, Zoom
    (`mcp.zoom.us`; `client_secret_basic` supported for manual token exchange)
- **New connection search.** Landing page search spans Native MCP, Composio
  toolkits, and manual credentials — jump straight to a provider. Composio is
  ranked and styled as **last resort** when a native option exists (Recommended
  vs Fallback sections, badges, quieter type card).
- **Native MCP picker table.** Connections → New → Native MCP is a searchable,
  filterable, sortable table (category + auth filters, Connect link).
- **Delete dismissed inbox items.** On the Inbox **Dismissed** facet, multi-
  select and permanently **Delete** (owner-scoped). Active facets still mass-
  **Dismiss**; *Done* stays unselectable.

### Fixed
- **Run detail header cost** now prices prompt-cache halves (0.1× read / 1.25×
  write) instead of undercounting when caching engages — aligned with the step
  footer.

## [v2026.7.1] — Agent Library, knowledge-work skills + 9 MCP providers, Sonnet 5 default, new Tembo mark — shipped 2026-07-08

### Added
- **Agent Library.** A browsable catalog of ~124 ready-made starter agents
  across work areas (Sales, CS, RevOps, Finance, Legal, Data,
  Product/Engineering, IT…), ranked **connection-aware** so the starters you
  can actually run — given what you've connected — lead. Clicking a starter
  pre-fills the New Agent form and the existing Tembo Coding Agent flow turns
  it into a spec + PR. Starters live as one-file-per-starter YAML read at
  runtime, composed from shared archetype prompts. Public + in-app docs page.
- **Nine more native MCP providers.** Notion, Intercom, Atlassian (Jira),
  Asana, monday.com, Guru, Fireflies, Amplitude, and Apollo — all confirmed
  Dynamic Client Registration, so they're TAS-managed connections with no
  per-customer OAuth app and are enabled by default in the picker. Harvested
  from Anthropic's
  [knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins)
  connector catalog (batch 1).
- **Browse + install Anthropic knowledge-work skills.** The Skills install
  page now surfaces that repo's ~95 Agent Skills as a catalog — filter by
  work area, search, install with one click. Their `SKILL.md` format is
  exactly what TAS already mounts, so agents pick up role-specific domain
  expertise alongside the matching library starters.
- **Agent Skills documented for the Coding Agent.** `/for-agents` guidance
  now covers authoring and consuming Agent Skills.

### Changed
- **New agents default to Claude Sonnet 5** (`anthropic:claude-sonnet-5`).
  Model guidance flips the "start on Opus, then downgrade" playbook — Sonnet 5
  is agentic enough to be the starting point, with Opus 4.8 / Fable 5 reserved
  for the hardest work. Sonnet 4.6 is retired from examples, docs, the sample
  agent, and the CAP prompt.
- **New Tembo T mark.** The app and docs favicons (and the README badge) swap
  the old elephant-trunk logo for the new blocky-T mark, with cache-busting so
  stale favicons refetch.
- README refreshed to clarify setup and the project overview.

### Fixed
- Dropped the redundant "Create an agent that handles this task:" prefix on
  library-seeded agent requests.

## [v2026.6.29] — More MCP providers + confidential/instance connect, Clerk triggers, schedule-from-description, graceful drain — shipped 2026-06-30

### Added
- **Four more native MCP providers.** Amplemarket, Clay, Avoma, and Metabase
  join the native-MCP catalog and connect in a couple of clicks.
- **Confidential & instance-based MCP connect.** Two new connection shapes widen
  what TAS can authorize: **confidential Dynamic Client Registration** for
  providers that require a confidential OAuth client (this unblocked Avoma), and
  **instance-based providers** where the user supplies part of the server URL —
  e.g. your own Metabase host. Both keep the SSRF guards of the existing flows.
- **Optional API key on a native-MCP connection.** A connection can now carry a
  supplementary API key alongside its OAuth token (some providers gate write
  actions behind a scoped key the MCP token can't grant), with a per-provider
  note explaining **why** and **which scopes** are needed.
- **Trigger agents from Clerk webhooks.** Inbound Clerk events (Svix-signature
  verified) can fire an agent; the webhook signing-secret UI is now
  provider-agnostic so other signed-webhook sources slot in.
- **Scriptable run cancel.** `POST /api/v1/runs/[id]/cancel` kills an in-flight
  run from the API, complementing the in-app Stop button.
- **Auto-create a schedule from the agent description.** When you create an agent
  whose description names a recurring schedule ("every weekday at 9am"), TAS
  parses it and creates an enabled automation alongside the agent. Conservative —
  prose that merely mentions a time doesn't trigger one.
- **Timezone-aware automations (DST-correct).** Automations store an IANA
  timezone and the scheduler evaluates each cron in that zone, so a wall-clock
  schedule tracks daylight saving. The form gains a timezone picker (defaulting
  to your browser zone); existing automations keep firing in UTC.
- **Agents-owned on the Team dashboard.** Each member row shows how many agents
  they own, with a count of unowned agents so nothing falls through the cracks.
- **Copy button on the Definition tab** and **expandable tool-call errors** in
  the run step timeline.

### Changed
- **Graceful shutdown.** On deploy/restart the api now **drains in-flight runs**
  before exiting instead of killing them mid-execution.
- The new agent file is committed next to the user's request, and inbox guidance
  softens the OAuth-token-for-REST advice (an item now also accepts string
  context).

### Fixed
- **Prompt-cache token accounting.** Stopped double-charging cached prompt tokens
  and fixed live per-step input tokens under-reporting mid-run.
- **Connect flows.** Amplemarket and Metabase reject the auto-appended
  `offline_access` scope — no longer requested; an unset auth mode is treated as
  DCR so those connections stay editable; runs are registered before the
  subprocess spawns (no orphaned "running" rows on a crash at startup).
- **Sidebar.** Failing-agent alerts are scoped to your own runs (a teammate's
  failure no longer nags you), and the "Action needed" header no longer lingers
  over an empty section once its cards are dismissed.
- **LinkedIn (and any manual-credential) logo** now renders on the connections
  list, detail, and picker instead of a generic glyph.

## [v2026.6.28] — Agent web search, inbox triage + links, self-documenting tool reference — shipped 2026-06-25

### Added
- **Agent web search.** Agents can now actually search the web by declaring
  `capabilities: [WebSearch]` — it maps to pydantic-ai's provider-adaptive web
  search (native on Anthropic/OpenAI, local fallback otherwise). The capability
  was documented but silently ignored by the runner before.
- **Self-documenting tool reference.** The `/for-agents` reference now publishes
  each native-MCP tool's full **parameter schema** (name / type / required /
  description), not just a one-line description — so an agent author (and Tembo
  CAP) can discover a tool's exact arguments. The `tembo-agent-studio` reference
  is served without a token (its tools are TAS's own public API), and an instance
  can opt the whole reference public via `TAS_FOR_AGENTS_PUBLIC`.
- **Inbox links.** An agent can attach a clickable **Links** list to one inbox
  item via `links: [{ label, url }]` on `produce_inbox_item` — e.g. the top 10
  Linear tickets behind a single triage task. Links are also **auto-extracted**
  from an item's proposed text (Markdown + bare URLs) and context payload, so the
  list populates even when the agent didn't set the field. http(s)-only, deduped,
  capped.
- **Faster inbox triage.** Resolving an item now **advances to the next** one to
  review (with an "N more in your inbox" counter); the index gains **multi-select
  mass-dismiss**; and **Dismiss** is now always available on the item detail page
  (previously hidden when the agent supplied one-click options).

### Changed
- **Tool caches auto-refresh.** Every native-MCP + Composio connection's cached
  tool catalog now re-syncs on each deploy (and daily) instead of requiring a
  manual Connections → Refresh — so new/changed tools (and their schemas) appear
  on their own. Throttled so restarts don't re-storm provider APIs.
- **Agent ownership on first run** and the marketing landing copy refresh.

### Fixed
- **Pending agent-create ghost cards.** A chat-to-create whose commit didn't
  carry the reconcile marker could sit "Pending" forever and couldn't be
  dismissed; creates now auto-reconcile once the agent file lands in the repo,
  and Dismiss clears direct-commit creates too.
- **Inbox checkbox hit area** — a near-miss on the row checkbox no longer opens
  the item instead of toggling selection.

### Security
- **CodeQL batch** — least-privilege workflow `GITHUB_TOKEN`, complete
  markdown-table escaping, and log-injection hardening.
- **ReDoS fix** — the inbox link-extraction trailing-punctuation trim no longer
  uses a backtracking-prone anchored regex on agent-supplied URLs.

## [v2026.6.27] — Stop a run, security hardening, agent owners + Definition history — shipped 2026-06-23

### Added
- **Stop a running run.** A red **Stop run** button on the run detail page kills
  an in-flight (queued/running) run: it transitions to a dedicated new
  `cancelled` status (distinct from `failed`, so killed runs stay out of failure
  dashboards/badges) and the api SIGKILLs the run's subprocess. Operator+ only.
- **Definition tab now shows every version.** The agent's Definition tab renders
  the live draft plus every promoted stable version (switchable), and a
  **History** section listing every commit of the spec file on GitHub — short
  hash, date, and author — each linking to that version on GitHub.
- **Agent ownership.** A repo-committed agent with no owner is auto-assigned to
  the person who first runs it (chat-created agents already had an owner), so the
  Mine/Starred views and Locked/Fork rules attribute correctly.
- **Marketing homepage for the docs site.** The docs root is now a restrained
  splash landing page (replacing the bare "Redirecting…"), including a FAQ on how
  TAS differs from Claude Managed Agents and Claude Cowork, and a live GitHub
  star count in the header.

### Changed
- **Orphaned runs are reconciled on api boot.** A run executes as an in-memory
  task owning a subprocess, so any run still `queued`/`running` when the api last
  stopped (crash, deploy, restart) was orphaned and hung in `running` forever.
  The api now marks such rows `failed` on startup with a clear reason. (Durable,
  resumable execution remains the larger [#170](https://github.com/tembo/agent-studio/issues/170) effort.)

### Security
- **Invites are honored only for IdP-verified emails** ([#47](https://github.com/tembo/agent-studio/issues/47)) — an OAuth sign-in
  whose provider didn't assert `email_verified` no longer auto-joins a workspace
  by matching a pending invite.
- **OAuth state now has a TTL** ([#46](https://github.com/tembo/agent-studio/issues/46)) and the **permissive CORS layer was dropped
  from the api** ([#48](https://github.com/tembo/agent-studio/issues/48)) — it served only bearer-gated server-to-server routes,
  so the open CORS was needless attack surface.
- **Stopped logging CAP prompt payloads** ([#44](https://github.com/tembo/agent-studio/issues/44)) and **gated audit-log export on
  admin** ([#43](https://github.com/tembo/agent-studio/issues/43)).
- Overrode `hono` to `>=4.12.25` to clear Dependabot alerts ([#206](https://github.com/tembo/agent-studio/pull/206)).

### Fixed
- **Inbox privacy** — the Tasks Inbox was showing every member's items to all
  members. Items are now scoped to their owner (the run's acting user, or the
  human filer), with reads, the sidebar badge, and mutations all owner-scoped.

### Dependencies
- Routine Dependabot bumps across web, api, docs, and CI actions
  (better-auth, lucide-react, cron-parser, tower-http, Astro, `@types/node`,
  `@tailwindcss/postcss`, actions/checkout).

## [v2026.6.26] — Agent stars + forking, unified Automations, Locked agents — shipped 2026-06-20

### Added
- **Per-agent "Locked" toggle.** Workspace admins can lock a governed agent
  (e.g. regulated drafting): its in-app edits — Chat to edit, Improve, Fork, and
  correction/learning capture — are removed and its Versions / Activity /
  Learning history is hidden, so it changes only through direct repo PRs. Set on
  the agent's Settings tab (admin-only) and audited on change.
- **Unified agent Automations tab.** An agent's Automation tab now lists its
  schedules, event triggers, and inbound webhooks in one sortable, filterable
  table (matching the workspace Automations list), with a **New automation**
  type picker (Schedule / Event trigger / Webhook) in place of the separate
  inline forms.
- **Agent visibility — stars + forking.** Star agents (☆ on each row) to curate
  a personal list; the agents page defaults to **Mine + Starred** (agents you own
  or starred) with a **View all** toggle, so big teams aren't staring at
  everyone's agents. And **Fork** any agent into your own editable, owner-prefixed
  copy (`sales-gen` → `ryw.sales-gen`) — no name collisions, owned by you, shares
  the original's tools module until you change it. New `agent_star` table; agent
  names may now carry one optional `<handle>.` owner prefix.
- **One-command sandbox bring-up** — `./scripts/dev-up.sh` writes a dev `.env`
  (email/password sign-in, random secrets), boots Postgres + api + web via Docker
  Compose, and seeds an instance-admin login you can use immediately. Plus a
  `tembo.nix` (Rust toolchain on top of the sandbox's preinstalled Node/Docker)
  so [Tembo sandboxes](https://docs.tembo.io/features/sandbox/overview) and
  snapshots have what the build needs.
- **Local sample agents for dev** — when a workspace has no connected GitHub
  repo and `TAS_LOCAL_AGENTS_DIR` is set, agents load (read-only) from that
  directory instead of GitHub. `docker-compose.yml` mounts the repo's `./agents`
  and enables it by default, so the bundled samples list, view, and **run** with
  no repo or PAT. Chat-authoring / improvements (which open PRs) still need a
  connected repo.

### Fixed
- **Composio connection name mismatch** no longer triggers a false "Action
  needed" prompt (or a failed run): when an agent pins a toolkit slot by a name
  you authorized under a different one, your single active connection for that
  toolkit is now used regardless of the declared name — matching native-MCP.
- **Local sample agents** render without a connected repo — the workspace home
  and agent pages no longer redirect to repo onboarding when
  `TAS_LOCAL_AGENTS_DIR` is set.

### Security
- **Encrypted secrets are bound to their row** (AES-GCM AAD), so a ciphertext
  blob can't be moved to another row and still decrypt. Non-breaking (versioned
  blob; existing ciphertext keeps decrypting). Covers workspace secrets, native
  + Composio connection credentials, OAuth client secrets, Slack tokens, and
  webhook / API-key tokens.
- **Workspace favicon route** now requires membership — unknown slugs,
  unauthenticated, and non-member requests all return the generic default,
  closing a workspace-existence probe.

### Documentation
- **Example Agents** — a new docs page of copy-paste, connection-agnostic
  agent-creation prompts (email triage, ticket/issue roundup, CRM tasks, daily
  task list). Paste one into chat-to-PR authoring and it adapts to whatever
  you've connected — generating one agent per matching service.

## [v2026.6.25] — Email + password quickstart sign-in, docs refresh — shipped 2026-06-19

### Added
- **Email + password quickstart sign-in.** When no OAuth provider (Google /
  Microsoft / OIDC) is configured, the login screen now offers email + password
  — so a fresh instance is reachable with zero OAuth-app setup. Sign-up stays
  gated to `INSTANCE_ADMIN_EMAILS` / invited emails, and configuring any OAuth
  provider turns email/password off automatically (OAuth becomes the path).

### Documentation
- **New Tasks Inbox guide** — how items are produced, the action buttons that
  act in the source (Complete / Reply / Send and Archive / Archive), snooze,
  terminal dismiss, the learning loop, and the producer-side fields for agent
  authors.
- **Fuller agent-spec reference** (Authoring agents) — documented
  `model_settings`, `request_limit`, `retries`, `instrument`, and `skills`.
- **Connections** — the native-MCP catalog (TAS-managed vs bring-your-own OAuth
  app), the **Manage providers** setup for HubSpot/Gmail, and Gmail's Google
  Developer Preview gate.
- **Introduction + README** — now describe the full *definition → run → act
  (human-in-the-loop Tasks Inbox) → adapt* loop, and correct the principle to
  **"every change is a commit"** — a pull request by default, or a direct commit
  in YOLO mode (the old "every change is a PR" predated YOLO delivery).
- **Changelog page** — cleaner release headers (no brackets / shipped-date) and
  an H2-only "on this page" TOC.
- **Roadmap** — pruned ideas that have since shipped (adaptive corrections loop,
  Tasks inbox, direct-commit / YOLO mode).

## [v2026.6.23] — Tasks Inbox actions: act in the source — shipped 2026-06-18

### Added
- **Act on inbox items in their source system** — option buttons now run the real
  action on click, not just clear the item:
  - **Complete** a task in Dialed / Attio / Linear via a generic **native-MCP
    inbox executor** (the producing agent declares the tool + args; it runs on
    the clicking user's connection).
  - **Send / Send and Archive / Archive** for Gmail via a **Composio inbox
    executor** — Send replies and keeps the thread in your inbox, Send and Archive
    replies then files it out, Archive files without replying. Replies use an
    editable suggested draft (the LinkedIn pattern).
- **Linear native-MCP provider** (`mcp.linear.app`, TAS-managed OAuth) — the
  Linear tasks agent moved off Composio onto it.
- **Gmail native-MCP provider** — a manual / bring-your-own Google OAuth app (like
  HubSpot), with in-app setup guidance on Connections → Manage providers (redirect
  URI, the Gmail-specific API + scope steps, docs link). Google currently gates the
  Gmail MCP server behind its Developer Preview program, so Gmail can alternatively
  run through Composio.
- **`gmail-tasks` email-triage agent** — surfaces your top starred/important emails
  into the Inbox (capped, deduped) with a deep link and a suggested reply.
- **Deep links on inbox items** — an "Open in <source> ↗" link to the underlying
  Dialed task / Linear issue / Attio record / email thread (new `url` field).
- **Snooze + Dismiss escapes** on inbox items, with per-agent control over which
  clear actions appear (e.g. Gmail uses Archive instead of Dismiss).

### Changed
- **Inbox source shown as a provider logo** in the list + item detail (was the raw
  lowercase word); the technical Type column/badge is gone.
- **Sidebar Inbox badge stays live** — polls the active count so items an agent
  produces in the background appear without a manual refresh.
- **Task agents surface source content faithfully** — `dialed`/`attio`/`linear`/
  `gmail` run with ScaleDown off (no lossy compression of data they copy verbatim)
  and prioritize their queues (Linear: triage → in-review → in-progress → todo →
  backlog; Gmail: starred first; etc.).

### Fixed
- **Dismiss is terminal** — a re-running agent can no longer drag a dismissed item
  back into the Inbox (the reopen-on-new-activity path now skips dismissed rows).
- **Inbox actions tolerate a connection-name mismatch** — fall back to your sole
  active connection of the provider type when the agent's declared name differs.
- **Learning-mode checkbox no longer reverts after Save** — it revalidated the
  wrong tab and never re-synced to the saved value.
- **ScaleDown** now treats prior history as context and the new turn as the query
  (per the API), and safely compresses bulky prior tool outputs.
- **LinkedIn thread list pagination** uses the provider's real opaque cursor.

## [v2026.6.22] — ScaleDown prompt compression + agent cost/run — shipped 2026-06-18

### Added
- **ScaleDown prompt compression.** Optionally route bulky prompt/context through
  [ScaleDown](https://scaledown.ai) to cut frontier-model tokens. Set a ScaleDown
  key under Settings → LLM Providers, then opt in per agent with `scaledown: off |
  prompt | aggressive`. `prompt` compresses the static instructions once
  (cache-friendly); `aggressive` also compresses bulky history blocks each turn,
  memoized so Anthropic prompt caching keeps working. Best-effort end to end — any
  ScaleDown failure falls back to the original text, so it never fails a run.
  Savings show on the run detail ("5.1K → 1.8K tokens").
- **Avg cost/run on the agents table.** A new sortable column showing each
  agent's average estimated USD cost over its costed runs in the last 30 days.
- **`request_limit` agent-spec field** — cap an agent's model requests per run
  via Pydantic AI `UsageLimits` (#183).

### Changed
- **Automations table gained Run as.** The unified automations table now shows
  (and filters by) which user's credentials each automation runs as.
- **Run page polls less aggressively.** The run-detail auto-refresh now backs off
  (2s → 15s) instead of a fixed 1-second tick, so long runs don't trigger a full
  server re-render every second.

### Fixed
- **Sidebar "Action needed" failure card.** Uses the proper
  `sentiment-negative-subtle` surface (no more muddy brown in dark mode) and a red
  CTA instead of an orange-on-red clash.

## [v2026.6.21] — Tasks Inbox + LinkedIn triage agent — shipped 2026-06-17

### Added
- **Tasks Inbox.** One workspace queue of everything your agents are waiting on
  you for, pinned to the top of the sidebar with a live count badge. Each item
  carries the agent's proposed action — you review, edit, and submit. Search,
  filters, sortable columns, friendly (non-JSON) context rendering, and success
  toasts on every action.
- **Snooze.** Move an item out of the inbox for a set duration; it returns on its
  own — or sooner if a newer reply lands on the thread.
- **Agents work the inbox too.** It's a tool surface over Native MCP and the
  `/api/v1/inbox` REST API (`produce_inbox_item`, `list_inbox_items` with
  search / filter / sort, plus claim / propose / complete) — humans and agents
  act on the same queue as peers.
- **Action menus + one-click execution.** A producer can attach a set of typed
  options (a reply with an editable draft, or one-click actions), one marked
  recommended. The inbox renders them as buttons and *runs* the action on click
  (e.g. send or archive on the source system), not just records it.
- **Self-learning loop.** What you change versus what the agent proposed is a
  signal. Agents in "learning mode" aggregate signals and open a single
  improvement PR per cycle, rather than one per correction.
- **LinkedIn inbox-triage agent.** Pulls recent LinkedIn threads into the Tasks
  Inbox, drafts a reply from the full thread, and offers one-click **Send**,
  **Send + Archive**, or **Archive**. Keeps the queue capped at a few open
  threads (tops up, never piles on), skips threads you've archived / handled /
  snoozed, and pages back for fresh ones when the recent list is all handled.
- **Manual-credential connections.** Connect services with no OAuth (e.g.
  LinkedIn) by pasting a few values alongside setup instructions, stored as
  workspace secrets. "New connection" is now a four-type picker — Native MCP /
  Composio / Manual credential / Secret.

### Changed
- **Automations is one full-width table.** Schedules, event triggers, and
  inbound webhooks now live in a single searchable / filterable table instead of
  a three-tab split. "+ New Automation" opens a type picker (Schedule / Event
  trigger / Webhook), mirroring New connection.
- **Shared DataTable across every list.** Agents, runs, connections, inbox,
  automations, and the rest share one table component — consistent row hover,
  whole-row click, and sortable headers everywhere.
- **Skills page restructured** into a table of installed skills with a top-right
  "+ New Skill" picker and a clickable per-skill detail view.

### Fixed
- **Inbox sidebar count updates the moment you act on an item** — the workspace
  layout is revalidated on submit / dismiss / execute / snooze.
- **Runner:** import `AnthropicProvider` correctly when building Pydantic AI
  agents, and apply an explicit 300s read timeout on the Anthropic streaming
  client (#178).
- **API:** use axum 0.8 path syntax for `/runs/{id}`.

## [v2026.6.20] — Connections index polish, Skills detail, sidebar dismiss — shipped 2026-06-17

### Changed
- **Connections index is now searchable, filterable, and sortable.** The list
  reads like the agents/tools tables — a search box, a type filter, and
  sortable column headers (default A→Z by name) instead of a flat list.
- **Connection detail/edit cleanup.** Every attribute moved into the detail
  table (the header is just the logo + name); all actions (Refresh / Reconnect /
  Edit / Disconnect) sit top-right as buttons styled like the agent view. Edit
  shows only when the connection is actually editable (secret, Composio, or DCR
  native MCP), and renaming is a direct field on the edit page rather than an
  expand-to-rename toggle.
- **New connection is a two-step picker** — choose a provider / Composio /
  secret, then fill in just that option's form.
- **Skills: clickable detail view.** Each installed skill links to a detail page
  showing its install source (linked), repo path, file count, and the full
  SKILL.md rendered as markdown, with Remove top-right.
- **Sidebar "Action needed" prompts are dismissible.** A small Dismiss link next
  to Connect hides a connection prompt you don't intend to act on (per-user,
  persisted locally).

### Fixed
- **Self-key (Tembo) connections no longer flood the audit log.** The implicit
  Tembo Agent Studio connection is re-minted automatically; it no longer writes
  a "Connection authorized" event each time. Real OAuth authorizations are still
  audited.
- **Create-agent prompt hides defunct/renamed native providers** so the Tembo
  Coding Agent isn't offered connections that no longer exist.
- **CI lockfile.** Repaired a corrupted `web/pnpm-lock.yaml` (duplicate mapping
  keys) that broke `pnpm install --frozen-lockfile`.

### Dependencies
- Sweep of routine bumps: Next 16.2.9, axum 0.8.9, thiserror 2.0, shadcn 4.11,
  plus the Astro group, `@tailwindcss/postcss`, `eslint-config-next`, chrono,
  regex, uuid, `@types/node`, and `actions/checkout` v6.

## [v2026.6.19] — Connections & Slack apps reworked into list / view / edit — shipped 2026-06-16

### Changed
- **Connections reworked into an agents-style list.** The tabbed Connections
  shell (Native MCP / Composio / Secrets + an admin sub-page) is now one list of
  every connection you have — native-MCP and Composio OAuth plus workspace
  secrets — each row tagged by type, with a **"+ New connection"** button and,
  for admins, **"Manage providers"** (provider enable/disable + bring-your-own
  OAuth apps moved to `/connections/providers`).
  - **New connection** is a two-step picker: choose an option (a provider,
    a Composio toolkit, or a secret), then fill in just that option's form.
  - Each connection gets a **detail view** (status, tools, token expiry, with
    Refresh / Reconnect / Disconnect) and an **edit** view (rename, or rotate a
    secret). OAuth flows land you on the new connection's detail page; old
    `/connections/{native-mcp,composio,secrets}` URLs redirect to the new shape.
- **Slack apps moved to the Build menu, reworked into list / detail / edit.**
  Slack apps left Settings for **Build → Slack apps**: a list of apps (rows),
  a dedicated **New Slack app** view, a detail view with the setup checklist /
  request URLs / manifest / install, and an edit view for credentials. The
  install flow returns to the app's detail page.
- **Tools: admins see the whole workspace's catalog.** A workspace admin now
  sees tools from every member's active connections on the Tools tab, not just
  their own — so they can see what agents across the workspace can reach.
  (API/MCP/agent surfaces stay per-user.)

## [v2026.6.18] — Audit timeline detail + sign-in redirect for deep links — shipped 2026-06-16

### Fixed
- **Signed-out deep links now go to sign-in, not a 404.** A signed-out visitor
  following a deep link (e.g. `/<workspace>/audit`) hit a page that gates with
  `notFound()`, so they saw a 404 — which reads as a broken link, not "please
  sign in". An auth gate in the proxy (middleware) now redirects them to the
  sign-in landing with the intended path in `?next=`, and they return there once
  signed in. `/mcp` and `/for-agents` stay open (they authenticate with a bearer
  token, not a session).

### Changed
- **Audit timeline shows real detail for every event.** A full pass over the
  event log:
  - **Connections** show the provider (e.g. *Attio*, *Tembo Agent Studio*) and a
    stack tag (Native MCP / Composio), instead of a bare "· default" — native-MCP
    events store the provider slug, which the timeline now resolves to a display
    name.
  - **Every event kind has a human label and an inline summary** where it carries
    useful data (API keys, webhooks, native-MCP OAuth apps, provider toggles,
    secret connections, Slack apps/installs/messages, sign-ins with IP + browser,
    agent version promotions). Previously ~20 kinds rendered as raw strings like
    `api_key.created` with no detail.
  - **A per-row "Details" expander** reveals the full event payload for anything
    the summary doesn't surface.
  - **Member events record who invited.** Accepting an invite now records the
    original inviter (`invited by …`), which was previously lost once the invite
    was accepted.

### Dependencies
- **esbuild 0.28.1, vite 8.0.16, js-yaml 4.2.0, @babel/core 7.29.7.** Clears six
  Dependabot advisories across the two earlier rounds. All are dev/test/build
  tooling (never in the deployed runtime), and the vectors (Deno install path,
  Windows dev server, untrusted-YAML parsing the app doesn't do) don't apply to
  this stack — bumped to keep the security tab clean.

## [v2026.6.17] — Audit coverage for the API/MCP surface, sign-ins, and membership — shipped 2026-06-16

### Added
- **Audit coverage for the public API & MCP surface.** Mutations made through
  the REST API (`/api/v1`) and MCP server (`/mcp`) — which shipped unaudited in
  v2026.6.16 — now write to the audit timeline, stamped with `via` (`api` or
  `mcp`) and the acting API key so a programmatic change is distinguishable from
  an in-app one and traceable to a key. Covers automation create/update/delete,
  Slack-app create/update/delete, and `send_slack_message` (destination + length
  only — never the message body). Runs and agent-change requests aren't
  double-logged — they already project into the timeline from their own tables.
  The in-app Slack-app management actions, which were also never audited, now
  record the same events.
- **Sign-in audit events.** A successful login now writes an `auth.login` event
  (with IP address and user agent) to the timeline of each workspace the user
  belongs to, via a better-auth session hook.
- **Membership & setup audit events.** New events for inviting a member
  (`member.invited`), revoking an invite (`member.invite_revoked`), a member
  joining (`member.added` — on both admin-add and invite-accept), connecting a
  repo (`repo.connected`, which stores a GitHub PAT), creating a workspace
  (`workspace.created`), and syncing agent guidance (`guidance.synced`).

### Dependencies
- **esbuild → 0.28.1.** Clears two Dependabot advisories
  ([GHSA-gv7w-rqvm-qjhr](https://github.com/advisories/GHSA-gv7w-rqvm-qjhr),
  [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr)).
  esbuild is dev/test-only here (transitive via vitest/tsx/vite in `web` and the
  Astro toolchain in `docs`, never in the deployed runtime), and neither
  vector — the Deno install path and the Windows dev server — applies to this
  stack, but bumped to keep the security tab clean. `docs` needed a
  `pnpm.overrides` pin since `astro`/`vite 7` held esbuild at 0.27.x.

## [v2026.6.16] — Public API & MCP server, sub-agent orchestration, prompt caching — shipped 2026-06-15

### Added
- **Public REST API + MCP server.** Drive a workspace programmatically — from
  Claude Code or any HTTP/MCP client. A new **personal API key** (Settings →
  API keys) authenticates both surfaces as you (your role, your per-user
  connections), is shown once, and can be disabled or revoked anytime.
  - **REST API** under `/api/v1`: list/read agents, validate a spec, list/read
    and trigger runs, browse the tool catalog and connection status, manage
    automations, manage Slack bots (create/update/delete, admin only), and hand
    authoring to the Tembo Coding Agent (`POST /api/v1/agent-changes`). See
    [REST API](./docs/src/content/docs/api.md).
  - **MCP server** at `/mcp` (Streamable HTTP): the same capabilities as MCP
    tools (`list_agents`, `get_agent`, `validate_agent_spec`, `list_runs`,
    `get_run`, `list_tools`, `list_connections`, `list_automations`,
    `list_slack_apps`, `trigger_run`, `create_automation`,
    `request_agent_change`, plus admin-only `create_slack_app` /
    `update_slack_app` / `delete_slack_app`). Connect with
    `claude mcp add --transport http tas https://<host>/mcp --header "Authorization: Bearer tas_…"`.
    See [MCP server](./docs/src/content/docs/mcp.md).
- **Admin Slack-app management over the API & MCP.** The slack-apps surface
  (previously read-only) now supports create/update/delete, gated at
  `workspace_admin` on both REST (`POST /api/v1/slack-apps`,
  `PATCH`/`DELETE /api/v1/slack-apps/{id}`) and MCP (`create_slack_app`,
  `update_slack_app`, `delete_slack_app`) — matching Settings → Slack apps.
  Creation writes metadata only (the app comes up `configuring` and isn't live
  until an admin completes the one-time browser OAuth install), so no secrets
  are needed to create one over the API.
- **`send_slack_message` — real Slack DMs and channel posts.** Agents could only
  reach Slack via Composio, whose "DM" posts to the bot's own connected account
  (the human never sees it). A new `send_slack_message` MCP tool (operator-gated)
  + `POST /api/v1/slack-messages` use a workspace Slack app's bot token to DM a
  real person by `toEmail` (resolved to a real DM + notification) or post to a
  `channel`. So an agent on the `tembo-agent-studio` MCP can actually notify
  someone instead of self-DMing through Composio.
- **Sub-agent orchestration with rolled-up cost.** When an agent calls the
  `tembo-agent-studio` MCP `trigger_run` from inside its own run (an orchestrator
  fanning work out to per-source sub-agents), the spawned run is now linked to its
  parent (`run.parent_run_id`). The parent's run page gets a **Sub-runs** section
  listing each child with its tokens + cost, a **Combined** total, a **Prompt
  cache** read/write breakdown, and a **Sub-agents use** row of the MCP logos the
  children actually invoked.
- **Agents list: MCPs column + filter.** The agents inventory shows each agent's
  declared connection logos; for an orchestrator it also shows (dimmed) the MCPs
  its sub-agents bring in, derived from the `parent_run_id` graph. A **Filter by
  MCP** dropdown matches an agent on its own or its sub-agents' MCPs.
- **Native-MCP tool reference for the Tembo Coding Agent (`/for-agents`).** When
  TAS asks CAP to author or edit an agent, the prompt now lists native-MCP
  connection slots (provider → authorized names) alongside Composio slots, and
  links each instance's own cached tool reference at `GET /for-agents/<provider>.md`
  so CAP can learn a native MCP's exact tool slugs. Auth is a signed, expiring,
  `(workspace, user)`-scoped bearer token that unlocks only the tool catalog —
  stateless, no DB key. Connection context is now shared across all three authoring
  call sites (new-agent form, API `request_agent_change`, in-app chat edit).
- **Orchestration is the preferred multi-source pattern.** The Pydantic AgentSpec
  guide TAS syncs into every connected repo now steers CAP toward a thin
  orchestrator + focused sub-agents (driven through the `tembo-agent-studio` Native
  MCP: `list_connections` / `trigger_run` / `get_run`) instead of one agent holding
  every source's tools in one growing context — and to reuse an existing
  single-purpose sub-agent rather than duplicating it. The guidance version hash
  auto-bumps, so repos re-bootstrap the refreshed guide on their next request.
- **Native MCP: Tembo Agent Studio (self-key) and Dialed.** Added a
  `tembo-agent-studio` self-key native-MCP provider (so an agent can drive its own
  TAS instance) and [Dialed](https://dialed.day) to the native-MCP catalog. Agents
  declare them with `connections: [{ type: …, source: native-mcp }]`.
- **Anthropic prompt caching + cache-aware cost.** An agentic run re-sends the
  whole prompt every step, so the large static prefix (system instructions + tool
  schemas) was re-billed at full input rate on each of 10+ steps. The runner now
  caches the system prompt + tool definitions and rolls a breakpoint over the
  growing history (Anthropic models; a spec can override), billing the repeated
  prefix at the cache-read rate (~0.1×) after a one-time write surcharge (~1.25×) —
  roughly a 3–5× cost cut on tool-heavy runs. Cost accounting is now cache-aware,
  and the run-steps footer shows a `prompt cache: N read · M write` line when the
  cache engaged.
- **Provider logos on native-MCP surfaces.** A shared `mcpLogoUrl(slug)` helper
  serves local art for providers Composio's logo CDN doesn't carry (Pylon, Dialed,
  Tembo Agent Studio) and the CDN for everything else. Logos now render on the run
  page, the agents-list MCPs column, the agent **Uses** row, and all three
  native-MCP card states on the Connections page (each keeping its generic-glyph
  fallback).

### Changed
- **Native-MCP slots fall back to your sole connection.** A spec that pins a
  provider by a slot name the user didn't use verbatim (e.g. `name: default` vs a
  connection named `tembo`) was rejected as not-connected. Now, when the named slot
  is absent but the user has exactly one active connection for that provider, TAS
  uses it — at both run time and in the pre-run check. Ambiguous (2+ slots, none
  matching) still requires naming one.
- **Tool catalog hides orphaned tools.** `listToolsForUser` now surfaces a cached
  tool only when a matching active connection still exists, so tools from renamed,
  disconnected, or stale connections no longer linger (e.g. the duplicate listings
  after the `tembo` → `tembo-agent-studio` slug rename). Applies everywhere the
  catalog feeds: Tools tab, Connections, `/api/v1/tools`, MCP `list_tools`, and
  `/for-agents`.
- **Native-MCP authorizations request `offline_access`.** Providers that only
  issue a refresh token when the OIDC `offline_access` scope is requested (e.g.
  Dialed) were going dark when their short-lived access token expired. TAS now
  appends `offline_access` at authorize time when the auth server supports the
  refresh-token grant (DCR providers only). Existing such connections must be
  reconnected once to obtain a refresh token.

### Fixed
- **Native-MCP token refresh for Dialed/Fathom.** The Rust refresh path validates
  a connection's origin against its own hardcoded allowlist, which lagged the web
  catalog — so every Dialed refresh aborted, the expired token was used, and the
  run 401'd. Added Dialed + Fathom to the allowlist and a vitest drift guard that
  fails CI if a future catalog provider isn't mirrored into the Rust allowlist.
- **Defunct native-MCP connections can be cleaned up.** A connection to a provider
  that left the catalog (e.g. the old `tembo` self-key connection after the rename)
  lingered as an orphaned row that couldn't be disconnected and kept its minted
  `tas_` key alive. The Connections → Native MCP page now shows a "removed provider"
  banner with a one-click Remove that deletes the rows, revokes the self-key, and
  drops the cached tools.
- **Sidebar stopped nagging "Connect" under the single-connection fallback.** The
  sidebar's "Action needed" list reimplemented the missing-connection check with a
  strict slot-name match and lacked the native single-connection fallback, so it
  flagged a connected agent as needing attention. Both the sidebar and the run-
  blocking pre-flight now route through shared helpers so they can't drift again.
- **YOLO creates show a pending card immediately.** A YOLO (direct-commit) create
  is optimistically marked committed the moment CAP accepts it, but the agents page
  re-filtered pending creates to only submitted/PR-opened ones — so a YOLO create
  showed nothing until Tembo finished building it. The page filter now keeps
  direct+committed creates too, matching the query.

### Migrations
- `0049` (per-user, workspace-bound API keys) and `0050` (`run.parent_run_id` for
  sub-run linking) apply on the next Rust api restart.

## [v2026.6.15] — Fathom MCP, free-text agent names — shipped 2026-06-09

### Added
- **Run input on the run view.** A run started with an optional message now shows
  that text as an **Input** field (under Trigger) on the run detail page.
- **Fathom Native MCP.** Added [Fathom](https://fathom.video) (meeting
  notes/transcripts) as a native MCP provider — connect it from Connections with
  TAS-managed OAuth (Fathom supports dynamic client registration + PKCE, so
  there's no per-customer OAuth-app setup). Agents reach it with
  `connections: [{ type: fathom, source: native-mcp }]`.
- **Free-text agent names.** Name an agent in normal text (e.g. "Inbox Triage")
  — the create form slugifies it for the filename and saves the text as a new
  optional `title:` field on the spec. The agents list, agent page, and chat
  header show the `title` (falling back to the slug); the slug `name` stays the
  stable identifier for URLs, runs, and automations, so nothing else changes.

### Fixed
- **Run-now dropped the optional message.** The "Run now" dialog's submit button
  was a Radix `AlertDialogAction`, which dismissed (unmounted) the dialog the
  instant it was clicked — racing the form submission and sending the agent an
  empty `user_message` (so it behaved as if no input was given). Now a plain
  submit button: success redirects, errors keep the dialog open with the input.
- **Historical run-cost backfill.** Recomputed the stored `cost_usd` on existing
  runs against the corrected model rates (Opus $5/$25; gpt-5.x priced per
  variant), so the Runs list and dashboard totals match the run-detail estimates
  for pre-fix runs. Only rows with token counts + a known model family are
  touched; unknown models and already-correct families are left as-is.
  *(migration 0048)*

## [v2026.6.14] — Agent Skills, YOLO mode, Claude Fable 5 — shipped 2026-06-09

### Added
- **Agent Skills.** A workspace **Skills** area to install reusable Agent Skills
  (Anthropic's `SKILL.md` folders) into your repo under `skills/`, from three
  sources: the [skills.sh](https://www.skills.sh/) directory (by slug / GitHub
  URL), a custom `.zip` upload, or **imported from the Claude Skills API** (the
  org's custom skills + Anthropic's pre-built ones, via the version-content
  export). An agent opts in with a `skills:` field; at run time the named skill
  folders are mounted via pydantic-ai-skills so the model can load their
  instructions and run their scripts — **locally, with any model** (no Anthropic
  code-execution sandbox). Install/remove is workspace-admin and audited.
- **YOLO (direct-commit) delivery mode.** A per-workspace setting
  (**Settings → Tembo Coding Agent → Improvements delivery**) chooses how the
  coding agent's changes land: **Always PR** (default — a reviewable pull
  request) or **YOLO**, which commits straight to the default branch with no PR.
  The mode is read per request to shape the Tembo prompt, so toggling takes
  effect on the next submission with no repo re-sync. YOLO improvements show a
  terminal **Committed** status and link the landed commit; a best-effort scan
  finds the marker commit on the default branch to attach it. Switching mode is
  workspace-admin-only and audited. *(migration 0047 — `workspace.commit_mode`
  + `improvement.delivery` / `commit_sha` / `commit_url`)*
  - YOLO requires the default branch to accept direct pushes from the coding
    agent; if it's protected behind required pull requests, keep Always PR.
- **Claude Fable 5 support.** Agents can use `anthropic:claude-fable-5` —
  Anthropic's most capable widely-released model (Mythos-class, 1M context),
  GA on the Claude API as of 2026-06-09. Priced in the run-cost estimates at
  $10/$50 per MTok (web + API tables), and added to the authoring guidance as
  the top-capability step-up above Opus 4.8.

### Fixed
- **Opus run-cost estimates.** Corrected the `claude-opus` rate from the stale
  $15/$75 to the current $5/$25 per MTok (current Opus 4.5–4.8), so cost
  estimates and the stored `cost_usd` are accurate. (The $15/$75 rate only ever
  applied to the deprecated Opus 4.1/4.0.)
- **OpenAI gpt-5.x run-cost estimates.** The single `gpt-5` rate ($1.25/$10) was
  mis-pricing the whole gpt-5.x family. Added per-model rates for the current
  flagships and intermediate releases — gpt-5.5 ($5/$30), gpt-5.4 ($2.50/$15,
  + mini/nano), gpt-5.2 ($0.875/$7), gpt-5.1 ($0.625/$5) — ahead of the bare
  `gpt-5` catch-all. gpt-4o / gpt-4.1 / o3 were already correct. Authoring
  guidance now references `openai:gpt-5.5` instead of the older gpt-5.2.

## [v2026.6.13] — In-app docs, workspace rename, Automations area — shipped 2026-06-09

### Added
- **In-app documentation.** The product manual now ships inside the app, pinned
  to the exact version you're running — a **Docs** link in the sidebar opens a
  full viewer with search, a sticky collapsible nav whose open/closed state
  persists across sessions, and a GitHub-stars link in the footer. Content is
  organized by audience — **For Operators** (The Basics / Advanced), **For
  Admins** (workspace admin + self-hosting), and **For Instance Admins** — and
  every page, including the live **Changelog** and **Roadmap**, is bundled at
  build time so it always matches the deployed release.
- **Rename a workspace.** A new **Settings → General** section (workspace-admin
  only, now the default Settings tab) renames a workspace. GitHub-org style: the
  URL slug follows the name, and the previous slug is kept alive as a redirect —
  preserving deep links (`/old/agents/x` → `/new/agents/x`) — so existing links
  and bookmarks never break. Renames are recorded in the audit log. *(migration
  0046 `workspace_slug_alias`)*
- **Workspace-level Automations area.** A dedicated **Automations** section in the
  sidebar with its own nav — **Schedules**, **Triggers**, and **Webhooks** — so
  recurring runs and event wiring have a home across the whole workspace, not
  just per-agent. On the agent page, Schedules moved to the top of the renamed
  **Automation** tab.
- **Role badge in the shell.** Your workspace role (Workspace Admin / Operator /
  Viewer) now shows under your name in the bottom-left user menu.
- **Agents table filters.** Filter the agents inventory by label and by model.

### Changed
- **Roadmap rewritten** as a simple, unphased list of ideas — each described in a
  couple of sentences and linked to a GitHub Discussion holding a draft **TASIP**
  (Tembo Agent Studio Improvement Proposal) where you can weigh in.
- **Docs stay in sync by policy.** `AGENTS.md` now instructs coding agents to
  update the docs alongside feature changes, backed by a non-blocking CI reminder
  when app code changes without a matching docs change.

### Fixed
- **Reliable merged-PR detection for improvements.** Improvements with a known PR
  number are now confirmed via a direct PR fetch instead of the search API, so a
  merged improvement no longer lingers as "open".

## [v2026.6.12] — Live run timeline, output discipline, Native MCP admin — shipped 2026-06-08

### Added
- **Run view rebuilt as a live step timeline.** The run-detail page now shows
  one view — built live and identical when finished — of what the agent did,
  step by step: the model's narration (revealed word-by-word while running), the
  tools it called (provider logo + ok/failed/running badge inline), and a
  per-step **In / Out token + cost** readout, with a totals footer (In, Out, and
  combined total). A "Copy" button lifts the whole transcript (narration +
  answer + tool calls) as plain text. The final answer is the last step — no
  separate Output box.
  - The wrapper streams text deltas + tool-call/result events as they happen; the
    runner persists `run_step` / `run_tool_call` rows live so the table builds in
    place, reconciled authoritatively at run end.
  - Per-step token usage + per-tool-call attribution. *(migrations 0043
    `run_step`, 0044 `run.streamed_output`, 0045 `run_step.summary`)*
- **Output discipline for every agent.** A global instruction makes agents work
  silently — no step-narrating or raw tool-output dumps in the reply — while
  allowing one short "what I'm doing" line per tool step (which feeds the
  timeline narration). Stops agents from burning the output-token budget.
- **Real parallel-tool-call limiter.** Agents now default to
  `model_settings.parallel_tool_calls = False` — an API-level cap so the model
  issues one tool call at a time instead of fanning out parallel bursts that get
  providers (e.g. Attio) rate-limited. Opt back in per-agent via the spec. Paired
  with tool-use guidance to back off on `retry after` errors.
- **Native MCP admin screen.** A workspace-admin "Manage providers" screen
  (Connections → Native MCP) to enable/disable which providers members see and
  register **multiple named OAuth-app instances** per confidential provider, so a
  second connection can use a second app. *(migration 0042
  `workspace_native_mcp_provider` + instance columns on
  `workspace_native_oauth_client`)*

### Changed
- **Agents table:** Name is the first column with alphabetical default sort;
  Labels get their own column; the Framework column is gone; the Model column
  strips the provider prefix (`anthropic:claude-sonnet-4-6` → `sonnet-4-6`).
- **Per-agent Runs tab** reuses the workspace Runs table (same columns minus
  Agent + Input), keeping status/trigger/search filters.
- **Sidebar "Action needed"** collapses duplicate missing-connection alerts into
  one card ("HubSpot for 3 agents") instead of one per agent.
- **Dashboard:** dropped the "Workspace-wide activity" subhead; Recent runs now
  show who triggered each run.

### Migrations
- `0042_native_mcp_admin` — provider enable flags + OAuth-app instances.
- `0043_run_step` — per model-step token usage + `run_tool_call.step_ordinal`.
- `0044_run_streamed_output` — live partial output column.
- `0045_run_step_summary` — per-step narration text.

## [v2026.6.11] — HubSpot via Native MCP (bring-your-own OAuth app) — shipped 2026-06-08

### Added
- **HubSpot as a Native MCP provider** (`https://mcp.hubspot.com`). HubSpot
  doesn't support auto-registration (DCR) and uses a confidential OAuth client,
  so this adds a **"bring-your-own OAuth app"** mode to Native MCP — generic for
  any future non-DCR provider:
  - `McpProvider.authMode` (`dcr` | `manual`); manual providers run a
    confidential PKCE flow with an admin-stored client_id/secret instead of
    self-registering a public client.
  - An admin **Configure OAuth app** card on **Connections → Native MCP** shows
    the redirect URI to register and stores the client_id/secret (encrypted);
    the per-user **Connect** button is gated until it's configured.
  - Token refresh presents the confidential client_secret for these
    connections. *(migration 0041 `workspace_native_oauth_client`)*

  To use it: create a HubSpot MCP auth app with redirect URI
  `<origin>/api/connections/native/hubspot/callback`, paste its client_id/secret
  under Connections → Native MCP, then Connect and reference
  `{ type: hubspot, source: native-mcp }` in an agent.

### Changed
- **Automations** collapses by default on the agent Automation tab (matching
  Triggers + External webhooks), with a count in the title.

### Migrations
- `0041_workspace_native_oauth_client` (per-workspace BYO OAuth client for manual
  Native MCP providers). Applied on api boot.

## [v2026.6.10] — Agent view redesign + run-time connection guard — shipped 2026-06-08

The agent page was a long vertical stack; it's now a focused, Settings-style
view with a left side-nav. Plus a guard that stops a run before it starts when
the connections aren't set up. Web-only — no new migrations.

### Added
- **Agent view side-nav** — the agent page is reorganized into a shared header
  (name, version, owner, connections, primary actions) + a left tab rail, with
  one real route per tab: **Overview** (30-day dashboard + recent runs),
  **Runs**, **Automation** (triggers + webhooks + schedules), **Versions**,
  **Definition** (spec + tools module), **Activity** (audit timeline), and
  **Settings**. Each tab fetches only its own data.
- **Connection icons on the agent view** — a row of the external services the
  agent uses, each with its **provider name + logo** (logos borrowed from
  Composio's library; a generic icon when a slug has none).

### Changed
- **Decluttered the agent header** — Delete moved to **Settings → Danger**;
  **Promote to Stable** moved to the **Versions** tab (the header keeps the
  read-only "Stable vN" badge); the ownership picker moved to **Settings** (the
  header shows a read-only owner). The header's action row is just
  **View source · Chat to edit · Run now**.
- **Triggers + External webhooks collapse by default** on the agent view, with a
  count in the title so configured items stay visible.

### Fixed
- **Block a run when the acting user's connections aren't set up** — a clear
  pre-flight message ("You haven't connected: HubSpot. Authorize under
  Connections, then run again.") instead of a pydantic-ai traceback mid-run.
  Applies to Run-now and Chat-to-edit.
- **Lint/CI** — pin `eslint` to 9 (eslint 10 removed an API `eslint-plugin-react`
  still uses, crashing the lint step), and fix the placeholder Dependabot config
  (real per-ecosystem groups; Astro + Starlight always bump together).

### Dependencies
- A wave of Dependabot updates: Next 16.2.7, React 19.2.x, Astro 6.4.4,
  TypeScript 6, and many GitHub Actions (`checkout`, `setup-node`, the docker/*
  actions, codeql, pages) — all verified green.

## [v2026.6.9] — Agent lifecycle, tool observability, and the ETL-agent stack — shipped 2026-06-08

A big release. Agents gain a real **version lifecycle** (draft → stable) and
**tool-call observability**, and a new **ETL-agent stack** lands: agents can run
deterministic **Python tools**, authenticate them through a new **Secrets**
substrate, and be **triggered by external webhooks** (Clay first). The full
**user manual** is now published, and the `guides/` directory moved into it.

### Added
- **Agent versioning & lifecycle** — agents now have a **draft** (the live repo
  file) and a promotable **stable** snapshot frozen in Postgres. Promotion
  records owner + version; runs default to **stable** for predictability (chat
  iterates on draft). The agent page shows version history, the draft↔stable
  diff, and a change summary. *(migration 0037)*
- **Sidecar Python tools** — a Pydantic agent can declare `tools_module: foo.py`,
  a sibling file of deterministic functions the model calls as tools (transforms,
  scoring, ETL) at **no token cost**. Schemas derive from each function's
  signature + docstring; calls are captured like MCP tools. Extra deps go in
  `api/scripts/requirements-tools.txt`.
- **Secrets — the 3rd connection substrate** — free-form, per-workspace API keys
  (e.g. Clay) set under **Connections → Secrets** (admin-managed, AES-256-GCM).
  Sidecar tools read a value via `tas_tools.secret("<name>")`; injected only
  into runs that have a tools module. *(migration 0039)*
- **External webhook triggers** — a per-agent inbound endpoint
  (`/api/hooks/webhook/<id>`) fires a run from any outside system. Built for
  Clay's model: `POST` JSON + an `Authorization: Bearer <token>` header
  (constant-time verified, shown once, rotatable); fire-and-forget 202. The
  request body reaches the agent as a `{trigger_type, webhook, payload}`
  envelope. *(migration 0040)*
- **Tool-usage tracking** — every tool an agent calls is captured per run
  (success + failure), rolled up per agent over 30 days, and surfaced in a
  workspace-wide, filterable **Tool uses** view. *(migration 0038)*
- **Pylon** as a Native MCP provider.
- **Two-level collapsible sidebar** navigation (Build / Activity / Integrations /
  Workspace).
- **Published user manual** — an Astro Starlight site at
  <https://tembo.github.io/agent-studio/>, deployed from `docs/` on every change.

### Changed
- **Prefer Native MCP over Composio** in the agent-authoring guidance, with a
  dynamic provider list; default model guidance moved to `claude-opus-4-8`, and
  the `labels:` extension field is documented.
- **`guides/` merged into the docs site** and deleted; the README and deploy
  guides now point at the published manual.

### Fixed
- **Native MCP token refresh** for short-lived tokens (Pylon ~5-min tokens) via a
  per-provider refresh allowlist.
- **Composio**: surface connect errors instead of swallowing them; support
  bring-your-own-auth toolkits; flag unknown toolkit slugs; fix a Pylon→Linear
  OAuth misroute and a "no active connection" false negative.
- **Agent versioning**: fix a promote crash (`FOR UPDATE` with an aggregate) and
  owner-picker name disambiguation.
- **"Improve the Agent"** now surfaces a thrown/stale server action ("refresh —
  a new version shipped") instead of failing silently.
- **Docs build**: upgrade Starlight to 0.39 for Astro 6 compatibility, and
  replace the placeholder Dependabot config with real per-ecosystem groups
  (Astro + Starlight always bump together).

### Migrations
- `0037_agent_version`, `0038_run_tool_call`, `0039_workspace_secret_connection`,
  `0040_workspace_webhook`. The api applies them on boot.

## [v2026.6.8] — Slack apps: launch agents from Slack — shipped 2026-06-04

TAS can now host per-team Slack bots that launch a **label-scoped subset** of
your agents — separating cheap routing from right-sized execution, so dozens of
agents are reachable from Slack without dozens of channels or one expensive
mega-agent.

### Added
- **TAS-managed Slack apps** (Settings → Slack apps, admin-only) — register one
  bot per team (e.g. a sales bot and a support bot), each scoped to a subset of
  agents by label. Coached setup: copy a prefilled Slack manifest, paste
  credentials, then **Add to Slack** (OAuth) to install. Signing secret, client
  secret, and bot token are AES-256-GCM encrypted; multi-app from day one.
- **Launch agents from Slack** — slash command `/tas <agent> <input>`,
  `@mentions`, and DMs. The run acts as the Slack user (matched by email),
  falling back to the app's default owner, and the result posts back in-thread.
- **Agent labels** — add `labels: [sales]` to an agent spec to group it in the
  inventory and scope which Slack app may launch it. Documented as a TAS
  extension field in [`AGENT_FORMAT.md`](./context/shipped/0.1/AGENT_FORMAT.md).
- **Natural-language routing** — a Slack message that doesn't name an agent is
  routed by a cheap Haiku 4.5 classifier to the best-fit scoped agent (or replies
  with the menu when nothing fits).
- **Agent picker modal + App Home directory** — `/tas` with no agent opens a
  picker; the bot's Home tab lists every agent it can launch.
- **"Run agent on this message" shortcut** — launch an agent with any Slack
  message as its input, prefilled into the picker.
- **Runs "Source" column** — the runs list now shows how each run was instigated
  (Manual / Scheduled / Event / Slack), who it acted as, and — for Slack — a deep
  link back to the originating conversation.
- **Dashboard "Slack (30d)" column** — per-member count of Slack-launched runs,
  with a per-bot breakdown on hover.

### Changed
- Slack replies render the agent's Markdown as Slack **mrkdwn** (bold, headings,
  links, bullets, tables) and drop the leading `user>` transcript echo.
- Dashboard **Team** rows append the email when two members share a first name.

### Hardening
- Per-Slack-user rate limit, replay dedupe on Slack retries, and an audit event
  (`slack.dispatch`) per Slack-launched run.

### Fixed
- Slack Web API calls are now form-encoded — fixing the read methods that
  silently ignore a JSON body, so the acting-user email→member mapping and the
  message permalinks (the "View in Slack" links) work.

## [v2026.6.7] — Team visibility + admin management — shipped 2026-06-04

A batch focused on workspace admins seeing and managing what members own.

### Added
- **Team section on the dashboard** — a per-member table (Connections /
  Automations / 30-day runs), sorted by run activity. Hover a count for the
  underlying list (which toolkits are connected, which agents have
  automations) via a styled, fast tooltip.
- **Member detail view** — admins click a member (from Settings → Members or
  the Team table) to see their tool connections, the automations that "Run as"
  them, and their recent runs. Useful before offboarding (see #64).
- **Admins can view + rename any member's connections** — a "Viewing" dropdown
  on the Connections page (defaults to self). When viewing another member you
  can Rename and Refresh; Connect/Reconnect/Disconnect are hidden since OAuth
  must be performed by that member.
- **Admin "Run as" in the manual Run-now dialog** — pick which member to run as;
  the run uses that member's connections (same model as an automation owner).
- **"Run as" owner column** on the automations list.

### Changed
- Member rows: **Remove** is red with a confirm step, and the whole row links to
  the member detail view.
- The Composio connection-rename action is now gated to owner-or-admin (parity
  with the native-MCP rename).

## [v2026.6.6] — Dismiss pending agents + settings polish — shipped 2026-06-04

### Added
- **Dismiss pending agents** from the workspace home. In-flight chat-to-PR
  creates can now be removed from the inventory via an inline confirm
  (operator+); it stops tracking the create here and leaves the GitHub PR
  alone (the PR / Tembo-session links still reach it).

### Fixed
- **Composio webhook secret field** no longer implies a `whsec_` prefix — those
  secrets are prefix-less hex, so the masked preview/placeholder were
  misleading (same class of fix as the Tembo API key field in v2026.6.5).
- **Sidebar "Action needed" CTA** (the "add an LLM key" prompt) now updates
  without a manual browser refresh when a provider key is added or removed — it
  lives in the workspace layout, which now revalidates at layout level.

## [v2026.6.5] — Tembo authoring fix + favicon fixes — shipped 2026-06-03

### Fixed
- **Tembo Coding Agent authoring (the "Invalid token" 401).** Requests now hit
  `POST /public-api/task/create`, where the workspace's Tembo API key
  authenticates as `Authorization: Bearer`. We were calling the bare
  `/task/create` path, which a different internal auth gate rejected with
  "Unauthorized - Invalid token" — so new-agent / chat-to-edit / Improve failed
  even with a valid key. **This is the fix that unblocks authoring.**
- **Workspace favicon blank in production.** The favicon route's redirect used
  the container's internal address (`https://0.0.0.0:8080/…`) behind the proxy,
  which the browser can't reach; it now emits a relative `Location`. Also
  cache-busts the default and per-workspace favicon URLs so a stale per-origin
  favicon entry clears (and switching a workspace's favicon actually updates).
- **Tembo API key field** no longer shows a misleading `tembo_` prefix in the
  masked preview/placeholder — keys are prefix-less.

### Added
- **Actionable Tembo auth errors.** A rejected/rotated key now surfaces "Tembo
  rejected the API key — update it under Settings → Tembo Coding Agent" instead
  of a raw 401, across the new-agent / chat / Improve flows.
- **Setup guide:** the agents repo must also be authorized in Tembo (Settings →
  Integrations → Source Control) for the coding agent to open PRs.

### Changed
- Sidebar agents icon matched to Tembo's (#61).
- Docs: clarified CalVer is year.month + a per-month release counter (not the
  day of the month).

## [v2026.6.4] — Workspace deletion, invite auto-join, LLM-key CTA — shipped 2026-06-03

### Fixed
- **Invited existing users now join automatically.** Inviting someone who
  already had an account previously left a pending invite with no way to accept
  it — on sign-in they were prompted to create their own workspace instead of
  landing in the one they were invited to. Existing users are now added to the
  workspace at invite time, and any already-pending invite resolves on the
  user's next sign-in. (Recommended upgrade for instances using invitations.)

### Added
- **Delete a workspace** — Settings → **Danger** tab, with a type-to-confirm
  step, gated to workspace admins. Removes all workspace data (members, runs,
  schedules, connections, secrets, settings, audit, invitations); the GitHub
  repository and its agent files are not touched.
- **Sidebar CTA when no LLM provider key is set** — a workspace with neither an
  Anthropic nor OpenAI key now shows an "Action needed" card linking to
  Settings → LLM Providers, since agents can't run without one.

## [v2026.6.3] — Security hardening, dashboard runs, version surfacing — shipped 2026-06-03

A security-focused release (several authorization/tenant-isolation fixes), plus
dashboard and CI improvements. **Recommended upgrade for all instances.**

### Fixed (security)
- **Reject an insecure placeholder `BETTER_AUTH_SECRET` at runtime** — the app
  now refuses to start with the dev placeholder secret, so a misconfigured
  deploy can't run with a guessable session-signing key (#52).
- **Tenant scoping on the run-detail endpoint** — `get_run` now enforces the
  caller's workspace, preventing cross-workspace run reads (#58).
- **Authorization check on repo connect** — `connectRepoAction` was missing a
  role check; added it so only authorized members can connect a repo (#55).
- **Mass-assignment fix** — `owner_user_id` can no longer be set from request
  input (#56).
- **SSRF + token exfiltration fix** — closed a server-side request forgery /
  token-leak path (#57).

### Added
- **Settings → Version tab** — shows the running release (release builds link to
  their GitHub release; edge/CD builds link to the commit).
- **Recent runs on the dashboard** — the latest runs workspace-wide, above
  Improvements, with fully clickable rows linking to the run.

### Changed
- **CI checks gate + tests on PRs.** A `checks` workflow now runs on every PR:
  web typecheck + vitest + eslint (now blocking after the lint cleanup in #54),
  and api `cargo fmt --check` + clippy + `cargo test`. A separate pipeline
  continuously deploys `main` to Tembo's internal instance behind that gate.
- **Docs:** Railway guide documents pinning explicit version tags for
  production vs. `:latest` for throwaway instances.

## [v2026.6.2] — Reproducible runtime, setup guide, Microsoft sign-in fix — shipped 2026-06-02

A small maintenance release: lock the last floating runtime dependency so a
rebuilt image tag is reproducible, ship a start-here setup guide, and fix
Microsoft Entra sign-in for self-hosted instances.

### Fixed
- **Microsoft Entra sign-in.** Entra commonly omits the `email` claim from both
  the id_token and the userinfo endpoint (the address lives in
  `preferred_username`/`upn`), which made better-auth fail sign-in with
  `email_is_missing`. The Microsoft provider now decodes the id_token and
  derives the email from `email ?? preferred_username ?? upn`.
- **Opaque sign-in errors.** Failed OAuth callbacks redirected back with a bare
  `?error=<code>` and no UI feedback; the sign-in page now renders an actionable
  message (invite-only, missing email, token exchange, …) and surfaces the raw
  code for support.

### Changed
- **Pinned `composio==0.13.1`** in the api runtime image. It was the one
  unpinned Python dep (pydantic-ai and pyyaml were already pinned); since
  Composio ships frequently, an unpinned bump could break connection-using
  agents on the next rebuild of a given image tag.

### Added
- **Version on the login screen.** The footer now reads "powered by Tembo Agent
  Studio `<version>`" so operators can see at a glance which release an instance
  is running. The version is **baked into the image at build time** (web
  Dockerfile `TAS_VERSION` build-arg), so it always matches the running image —
  no env var to set or keep in sync per instance.
- **`guides/CUSTOMER_SETUP.md`** — a zero-to-running checklist covering
  everything a new customer must procure and do: infra, auth provider, LLM
  keys, secrets, deploy env, first-run instance-admin bootstrap, per-workspace
  setup, and creating the first agent. Linked from the README as the
  start-here guide.

## [v2026.5.31] — Container image publishing — shipped 2026-05-31

Makes TAS deployable from prebuilt images instead of a source build, and
hardens the supply chain around them.

### Added
- **Container images published to GHCR.** A release workflow
  (`.github/workflows/release.yml`) builds and pushes `tas-api` +
  `tas-web` to `ghcr.io/tembo/` on every `v*` tag, tagged
  `<version>` / `<major>.<minor>` / `latest`. Images are **cosign**
  keyless-signed and carry SBOM + provenance attestations; **Trivy**
  scans each image (report-only). A `compose.release.yaml` runs the
  stack from those images (`docker compose -f compose.release.yaml pull
  && up -d`), pinned by `TAS_VERSION` and kept in lockstep with each
  release via an auto-opened PR. Customers no longer compile Rust/Node
  on their host.
- **Onboarding sign-out link.** A "Signed in as … Not you? Sign out"
  affordance on both onboarding steps (`/onboarding` and
  `/onboarding/repo`) so someone who authenticated with the wrong
  Google account can recover without an app shell to hang a user menu
  off of.
- **Dependabot** enabled for GitHub Actions + npm.
- **Instance-admin role + root `/settings`.** Deployment-level admin via
  the `INSTANCE_ADMIN_EMAILS` allowlist, and a root `/settings` surface
  (instance-admin only) with an editable, DB-backed instance name
  (`instance_settings`, migration 0031; env fallback).
- **Invite-only instance + workspace invitations.** Account creation is
  rejected unless the email is an instance admin or has a pending invite.
  Workspace admins invite by email (migration 0032) and get a copy-paste
  template; invitees auto-join their workspace(s) on first sign-in.
  Workspace creation is instance-admin-only. `INSTANCE_ADMIN_EMAILS` is
  the required bootstrap env (without it nobody can sign in to a fresh
  instance).
- **Build fix:** `api/build.rs` (`rerun-if-changed=migrations`) so new
  migrations actually embed in the image — `sqlx::migrate!` is
  compile-time, and a migration-only change otherwise got cached out.

### Changed
- **api image runs as a non-root user** (uid 1001), matching web. The
  run path writes nothing to disk (spec via stdin, result via stdout),
  so no writable app dir is needed.
- **api defaults to a dual-stack bind** (`API_BIND_ADDR=[::]:8080`).
  Serves IPv4 + IPv6, so Docker Compose is unchanged while IPv6-only
  private networks (e.g. Railway service-to-service) reach the api with
  no configuration.

### Fixed
- **Client auth base URL is resolved at runtime** from the browser
  origin instead of the build-time `NEXT_PUBLIC_BETTER_AUTH_URL` (which
  is inlined when the image is built, so a prebuilt GHCR image baked
  `http://localhost:3000` and sign-in failed on any real domain). Fixes
  sign-in for every image-based deploy.
- **postcss bumped to ≥ 8.5.10** via a pnpm override to clear
  GHSA-qx2v-qp2m-jg93 (a CSS-stringify XSS in the copy Next pins
  transitively). Not reachable in TAS — build-time, dev-authored CSS —
  resolved to clear the alert and de-dupe to one postcss.

## [v2026.5.29] — First CalVer release — shipped 2026-05-29

The cutover to date-based releases. Everything through Phase 0.4
(Governance depth) is captured below; this tag marks the first release
cut from `main` under the new scheme and ships one new capability on top
of v0.4.

### Added
- **Native-MCP OAuth token auto-refresh.** The runner now refreshes
  expiring native-MCP access tokens *before* a run reads them, instead
  of letting an expired token reach the agent and 401 mid-run. For any
  active oauth2 native connection (e.g. Attio) whose `token_expires_at`
  is at/near expiry, it spends the stored `refresh_token` (granted via
  `offline_access`) for a fresh token at the provider's discovered token
  endpoint, re-encrypts the credentials, and bumps `token_expires_at`.
  A rejected refresh (dead refresh token) proactively flips the
  connection to `stale` so the UI prompts Reconnect; transient failures
  are logged and the run proceeds on the existing token. Best-effort and
  per-connection. `crypto.rs` gained an `encrypt()` twin to its existing
  `decrypt()`; refresh lives in the runtime (`native_oauth.rs`) so no
  plaintext round-trips through the web container.

### Changed
- **Roadmap tracking moved to GitHub Issues.** Phase 0.5 / 0.6 user
  stories and the backlog are now issues (label `enhancement`; 0.5 and 0.6
  milestones, backlog = no milestone). The `context/*/USER_STORIES.md`
  docs are redirect pointers to the issues and retain design rationale +
  out-of-scope notes.
- **Version files adopt CalVer.** `api/Cargo.toml` and
  `web/package.json` move from the long-stale `0.1.0` to `2026.5.29`.

## [v0.4] — Governance depth — shipped May 2026

### Added
- **Native MCP connections.** Second connection substrate alongside
  Composio: TAS-managed OAuth straight to the provider's official
  MCP server. The user clicks Connect and TAS performs MCP-spec
  discovery + Dynamic Client Registration (RFC 7591) + PKCE under
  the hood — no per-provider OAuth-app setup, no `build.attio.com`
  side quest. `lib/mcp-providers.ts` is a one-line-per-provider
  catalog (today: Attio); everything else (auth URL, token URL,
  scopes, DCR endpoint) is read from `/.well-known/oauth-protected-
  resource`. Agent spec `connections:` entries dispatch by
  `source:` (`composio` default, `native-mcp` opt-in); the Python
  wrapper builds one `MCPToolset` per declared (provider, name)
  slot with the user's bearer token in `Authorization` headers and
  honors `tools:` narrowing on native entries via
  `FilteredToolset`. Rust runner decrypts the `workspace_connection`
  row per acting user and ships the credentials as
  `TAS_NATIVE_MCP_CONNECTIONS` env.
- **Unified tool catalog + Tools tab.** Normalized
  `workspace_mcp_tool` table (migrations 0029 + 0030) caches every
  tool exposed by any connection, indexed by source + provider +
  connection name. Primed on connect, refreshable from a per-row
  button on the Connections page, cleared on disconnect. New
  workspace-level `/<workspace>/tools` page lists everything in a
  searchable, filterable table with click-to-copy slugs — kills
  the "is it `RUN_BASIC_REPORT` or `run-basic-report`?" guessing
  game that the kebab-case-vs-UPPER_SNAKE_CASE split between
  Attio's MCP and Composio's REST wrappers used to force on you.
- **Lean CAP prompt + canonical agent guidance.** Tembo Coding
  Agent prompts dropped ~16KB by replacing the inline canonical-
  guidance block with a pointer at the on-disk files (Sync agent
  guidance pushes the canonical content to the customer repo on
  demand; a scheduled refresh lives in
  `context/backlog/`). `PYDANTIC_GUIDE` learned both connection
  substrates, the slug-case gotcha, and a Switching-from-Composio-
  to-Native-MCP recipe.
- **Test foundation (Vitest + Polly.js + Playwright/Cucumber).**
  `pnpm test` runs unit + integration in ~300ms covering the RBAC
  policy + the workspace-authorize funnel (the v0.4-02 deny-test
  exit-bar item — operator is denied workspace_admin actions,
  no-session short-circuits before workspace lookup so existence
  isn't leaked). `pnpm test:bdd` drives a real Chromium through
  Gherkin-style feature files via Cucumber.js — pilots: anon
  redirects to sign-in, signed-in workspace_admin lands on the
  dashboard (seeded via direct Postgres write + HMAC-signed
  session cookie). HTTP fixtures recorded as Polly.js cassettes.
- **Immutable audit changelog (US-0.4-01).** Append-only
  `audit_event` table records actor / when / source / target /
  payload for the event types that don't already live in another
  table (secret rotations, connection authorize/disconnect/rename,
  automation lifecycle, trigger lifecycle, agent delete/restore,
  repo disconnect). The unified timeline reads explicit writes
  UNION'd with derived projections of `run` + `improvement` (both
  already event-shaped), so v0.3 emitters needed zero
  re-instrumentation. Workspace-wide `/<workspace>/audit` page
  with source / actor / agent / time-window filters (URL-driven,
  deep-linkable). Per-agent Timeline section on the agent detail
  page with click-through to the full history. New `Audit`
  sidenav item.
- **Audit JSON export (US-0.4-04).** "Export JSON →" affordance
  on the audit page (honors current filter set) and the per-agent
  Timeline (scoped to that agent). Envelope carries the filter
  snapshot + truncated flag alongside the rows. Export is itself
  audited (`kind=audit.exported`). Capped at 10,000 rows per
  download — streaming to a SIEM is the v0.5 open question per
  the story carve-out.
- **RBAC (US-0.4-02).** Three workspace-scoped roles —
  workspace_admin, operator, viewer — with a strict hierarchy.
  `lib/rbac.ts` + `lib/auth-server.ts` centralize the policy
  layer; every mutating server action and OAuth route now
  funnels through `authorizeWorkspace(slug, minRole)` and
  returns DENIED_MESSAGE on insufficient role. Role assignments
  are themselves audited (`source=policy_change`,
  `kind=member.added | member.role_changed | member.removed`).
  New Settings → Members section with role picker, add-by-email,
  and remove affordances (workspace_admin only); last-admin
  demotion is blocked in the DB helper. UI affordance hiding
  (New agent, Run now, Delete agent, Chat-to-edit) keys off the
  current user's role; server enforcement remains the contract.
  Org-admin tier deferred until there are concrete cross-workspace
  endpoints to gate on it.
- **RBAC-half of US-0.4-05 closed.** Role-assignment audit events
  (`member.added` / `member.role_changed` / `member.removed`) now
  carry the target user's name + email in the payload, and the
  audit UI renders them as readable rows ("Alice · viewer →
  operator" rather than the raw uuid). The audit-export event
  (`audit.exported`) renders the filter snapshot + row count.
  The policy-half of the AC (template version diffs, override
  events with justification) stays open until the policy
  substrate ships, since those event types don't exist yet.

### Scope moves
- **API-level deny test in CI → v0.4+.** The v0.4-02 AC asks for
  CI-verified API enforcement. Vitest deny-tests on the
  `authorizeWorkspace` funnel land in v0.4 itself
  (`web/src/lib/auth-server.test.ts`); the GitHub Actions workflow
  that would run them on every PR is in
  [`context/backlog/`](./context/backlog/USER_STORIES.md) — the
  enforcement is locked in by code + test, CI is the missing
  enforcement of the test.
- **US-0.4-03 (org-level policy templates) → Backlog.** Needs an
  org concept (a scope above workspace) plus a generic policy
  resolver substrate; the rest of v0.4 ships cleanly without it.
  Pulls forward when a concrete customer use case lands or when
  v0.5 prep needs the substrate.
- **New `context/backlog/` folder.** Sibling to the numbered
  phase folders; holds designed-but-unscheduled stories with
  `Moved from: vX.Y` provenance lines. Replaces the per-phase
  `Stretch (Considered, Deferred)` pattern as the home for
  stories that *don't* have a phase yet.
- **`context/shipped/` folder.** Shipped phase folders (0.1, 0.2,
  0.3) moved under `context/shipped/` so active phases stay
  uncluttered at the `context/` root. Docs themselves remain
  load-bearing references; only the directory layer changed.
  All cross-phase relative links updated; v0.4 → shipped uses
  `../shipped/0.X/`, shipped → v0.4+ uses `../../0.X/`, and
  sibling refs within `shipped/` stay as `../0.X/`. Root README +
  ROADMAP + a couple of source-file comments updated to point at
  the new paths.

## [v0.3] — Operational surface — shipped May 2026

The day-two surface. Agents reach external services through a real
substrate (no more "the model knows how to write Slack messages but
the runtime can't actually call Slack"). Operators get one screen
per agent that answers "how's it going?" and "if it's not, what's
broken?" — the v0.3 phase's "one screen, not four hours of log
spelunking" goal. The originally-planned rich-HITL pieces moved
out to make room for Connections, which ate the phase honestly.

### Added
- **Composio-backed Connections substrate.** External services
  (Slack, Gmail, Google Sheets, Notion, GitHub, Linear, HubSpot,
  Salesforce, … ~1,043 in Composio's catalog) for agents to call
  at run time. Authorized once per user per workspace via
  Composio's hosted OAuth, cached as a `workspace_composio_connection`
  row keyed by `(workspace_id, user_id, toolkit_slug, name)`.
  Per-user model: each member authorizes their own toolkits;
  scheduled runs use the automation's "Run as" owner. The
  workspace Composio API key is itself a workspace secret
  alongside Tembo / Anthropic / OpenAI keys.
- **Connections page (new top-level sidenav item).** Lists each
  `(toolkit, name)` slot declared by agents in the connected
  repo plus anything pre-authorized. Inline Disconnect /
  Reconnect / Rename actions per row, with toolkit logos pulled
  from Composio's catalog. "Add another connection" form sits at
  the bottom for pre-authorizing a slot before an agent declares
  it.
- **Toolkit picker.** Combobox over Composio's full catalog,
  alphabetized, filter-as-you-type, name + slug side-by-side
  per row with the toolkit's logo. Catalog cached in-process for
  1 hour.
- **Named connection slots.** Agent spec's `connections:` accepts
  `{ name, tools }` per toolkit so the same user can hold
  multiple Gmails / Slacks / GitHubs and an agent can target a
  specific one. Canonical form is named slot + narrow tools list
  (turns on Composio's DIRECT_TOOLS preset, ~10× cheaper input
  tokens than the loose search-and-execute path).
- **Pydantic-AI runtime pipe for Composio tools.** Python wrapper
  (`api/scripts/run_pydantic.py`) materializes a Composio session
  from the spec's `connections:` field, attaches it as an MCP
  toolset, and resolves each `(toolkit, name)` slot to the acting
  user's authorized connection. Imperative preamble prepended to
  the agent's instructions so tool-using models execute instead
  of hedging.
- **Per-agent operational dashboard.** Health header (colored by
  30-day failure-rate band), four stat tiles (Runs / Success rate
  / Spend / Avg duration), daily-trend bar (30-day strip with
  success / failure overlay), recent-failures grouping (top-5
  error prefixes by count, with a link to one example run each).
  Empty-history agents skip the dashboard so "0" tiles don't
  read as broken.
- **Persisted run cost.** New `run.cost_usd` column populated at
  `mark_succeeded` time using a model-pricing table mirrored
  in Rust (`api/src/pricing.rs`). Cost column on the workspace
  Runs page renders with the same bar-chart background as
  Duration, scaled to the highest cost in view.
- **Sidebar action-needed alerts.** When a repo agent declares a
  `connections:` slot the current user hasn't authorized, the
  sidebar shows "Connect {toolkit} for {agent}" with a direct
  authorize link. Per-user so each member sees their own gaps.
- **Multi-workspace support.** Sidebar workspace switcher,
  multi-workspace onboarding, `/` redirect lands on the
  last-visited workspace (via `workspace_member.last_visited_at`).
- **Automation "Run as" owner.** Scheduled runs use the
  automation's `owner_user_id` (defaults to creator). Owner
  picker in the automation form lists workspace members so the
  per-user connections model has a sensible answer for
  scheduled credentials.
- **GitHub fetch cache.** `listDirectory` + `readFile` cached
  for 60s tagged per repo via Next.js fetch tags. Writes
  (`createFile` / `updateFile` / `deleteFile`) bust the tag via
  `updateTag`. Cuts the sidebar-driven scan cost.
- **Event triggers (Composio-backed).** New `workspace_trigger`
  table binds a Composio trigger instance to an agent + owning
  user + connection slot. Per-workspace webhook endpoint at
  `/api/hooks/composio/{slug}` HMAC-verifies the inbound payload
  (`composio_webhook_secret` stored alongside the API key),
  resolves the trigger row, and enqueues a run with
  `trigger='event'`. Per-agent Triggers section on the detail
  page renders the list + a create form that takes a Composio
  trigger slug, a connection, and a JSON config. Event-driven
  runs show a purple **Event** badge on the workspace Runs page
  and the run-detail header.
- **Agent inventory.** Workspace landing page is now a sortable
  table (Status / Name / Framework / Model / Runs 30d / Success
  / Last run) instead of a card grid. Facet pills filter by
  Active / Idle / Error / Pending / Invalid with live counts;
  free-text search across name. Pending creates + invalid agent
  files render inline as their own rows.
- **Workspace dashboard.** `/<workspace>/dashboard` now mirrors
  the per-agent dashboard shape: health header banded by 30d
  failure rate, four stat tiles (Runs / Success rate / Spend /
  Avg duration), 30-day daily-trend bar, and a "Top failing
  agents (30d)" rollup with click-through to the latest failing
  run. Improvements counts + recent list stay below as
  secondary context.
- **Log explorer (on `/runs`).** Search predicate extended to
  ILIKE across `error_message` in addition to user_message +
  output. Failed rows surface a two-line error excerpt inline
  so triage scans don't require a click. `/runs` now reads
  `status` / `trigger` / `agent` / `q` from URL search params
  so deep links land prefiltered.
- **Failure-aware sidebar alerts.** "Action needed" rail now
  surfaces agents with at least one failure in the last 24h
  ("Agent X failed N× in 24h → Open") above the missing-
  connection alerts. Capped at five so a broken workspace
  can't shove the rail off-screen.
- **Failure investigation links on run detail.** Failed-run
  detail page now offers two jumps: "Find similar runs →"
  (deep-links into `/runs` filtered to the agent + status=failed
  + error-prefix search) and "View {agent} failure groups →"
  (anchored deep link into the per-agent dashboard's grouped
  failures section).

### Changed
- **Create-agent prompt slimmed and rebuilt around Connections.**
  `buildCreateAgentPrompt` drops the verbose guidance-refresh
  block, points Tembo at the in-repo `AGENT_GUIDE.md`, tells it
  the canonical `connections:` form is named slot + narrow tools,
  and recommends defaulting to `anthropic:claude-opus-4-7` for
  tool-using agents (Opus executes; lower-tier models hedge on
  multi-step tool dances), with downgrade-to-Sonnet documented
  as the cost-optimization step once an agent is reliable.
- **All `useActionState` forms switched to controlled inputs.**
  React 19's useActionState resets uncontrolled fields after
  each submission, including the returned-error path. Onboarding /
  repo-connect / secret-key / new-agent / run-now / automation /
  rename-connection forms all updated so a validation bounce
  doesn't wipe the user's typed input.
- **Empty-input run default.** The Python wrapper used to
  substitute `"Hello."` when a run had no user message — models
  greeted back instead of executing. New default is a directive
  (`"Execute the job described in your instructions."`).
- **Sticky sidebar.** Workspace nav stays put while the main
  column scrolls.
- **Toolkit allowlist removed.** Earlier in the phase, TAS
  hardcoded the set of Composio toolkits it recognized. That was
  actively blocking Tembo from declaring legitimate connections
  (e.g. an email-reading agent that wanted `gmail`). Connections
  are now declared by agents, and any Composio slug is accepted.

### Fixed
- **Delete-agent UI lag.** Action redirects with `?deleted={name}`;
  the agents grid defensively filters that name from the
  rendered list AND shows a confirmation banner. Instant
  feedback even when the GitHub fetch cache hasn't propagated.
- **Workspace secret validation accepted junk.** A literal HTML
  404 page text once landed in a workspace's Composio API key
  field. Per-kind prefix sniff at save now catches this (`ak_`
  for Composio, `sk-` for OpenAI, `sk-ant-` for Anthropic);
  the runtime no longer 401s silently when a non-key string
  was pasted.

### Scope moves
- **HITL pause/resume + rich forms → v0.4.** Originally a v0.3
  anchor; the Connections substrate ate the phase, and the
  remaining v0.3 work (workspace-wide triage surfaces + failure
  investigation) landed in its place. HITL is the next major
  substrate piece and anchors v0.4.
- **Workspace-wide triage surfaces → mostly shipped, residuals
  to v0.4.** Agent inventory ✓, workspace dashboard ✓, log
  explorer (extended `/runs`) ✓, failure-aware sidebar ✓.
  Topology map + tasks inbox land in v0.4 (tasks inbox depends
  on HITL anyway).
- **Event-trigger form polish → v0.3+.** Trigger slugs are
  currently entered as free text (linked to Composio's catalog).
  Schema-driven per-trigger config forms (pulled from
  `getTriggerType`'s `config` schema) land in a later iteration.

## [v0.2] — Authoring velocity — shipped May 2026

The chat-to-PR loop. A non-engineer describes an agent (or a change to one)
in plain English; Tembo opens a pull request; the team reviews a diff.

### Added
- **Chat-to-create.** New agents start from a chat description on the
  `/agents/new` page. Tembo writes a valid agent file in the chosen
  framework's canonical shape and opens a PR. Pending creates appear as
  dashed-border cards on the agents grid until the PR merges.
- **Chat-to-edit.** Each agent has a chat thread. "Send to agent" runs the
  agent with your message; "Submit change request" packages the message and
  hands it to Tembo, which opens a PR. Both intents share one composer.
- **Improvement loop.** Run-detail "Improve the Agent" form ships free-text
  feedback to Tembo as a coding task. The opened PR carries a marker that
  lets TAS correlate merged PRs back to the improvement row. New
  `/improvements` page lists every submission with status (submitted /
  PR opened / merged / closed).
- **Automations.** Scheduled runs via cron expressions. New `/automations`
  route with a list, create/edit form (live cron preview + next-fire in
  local time), and an enable/disable toggle. Agent detail page surfaces an
  agent's automations. Run rows show a "Scheduled" badge and link back to
  the automation. Single-process Node.js scheduler tick at 30s resolution,
  fires through the same `/internal/runs` path as manual runs.
- **Runs page.** Workspace-wide run list with status / trigger / agent
  filters, ILIKE search across input + output, cursor-paginated "Load
  more". Whole-row click navigates to the run detail. Relative-time
  "5m ago" inside 24h, absolute `LocalTime` beyond. Subtle bar-chart
  background on the Duration cell scaled to the longest run in view.
- **Dashboard.** Per-workspace landing page: active vs. all-time agent and
  run counts, weekly improvement breakdown, recent improvements feed.
- **Run-now with input.** Clicking Run now on the agent detail page opens
  a dialog with an autofocused textarea for the user message. Empty
  submission preserves the prior "no input" behavior.
- **Floating copy button** on the run-detail output card. Hover-only,
  cross-fades in over 150ms, strips the `[stop_reason]` suffix before
  copying.
- **OpenAI provider.** Agents can declare `openai:gpt-...` models alongside
  Anthropic.
- **AGENTS.md hierarchy.** A root `AGENTS.md` and `api/AGENTS.md` join the
  existing `web/AGENTS.md`. Each coding-request prompt to Tembo also pushes
  current TAS-managed guidance files into the customer's workspace repo:
  root `AGENTS.md`, `agents/AGENTS.md`, and per-framework `AGENT_GUIDE.md`
  files are refreshed on drift; customer-managed
  `ADDITIONAL_AGENT_INSTRUCTIONS.md` is created once, never overwritten.
- **Settings → Sync agent guidance.** One-click bootstrap or refresh of
  the guidance files into the connected workspace repo, for repos whose
  agents predate the auto-bootstrap.
- **LocalTime hover-to-UTC.** Datetime renders local with the local-tz
  abbreviation by default; hover/focus cross-fades to the same instant
  in UTC over 500ms. Uses inline-grid so the container sizes to the
  wider string and surrounding text doesn't jump.

### Changed
- **Passthrough runner.** Both supported frameworks now shell out to the
  upstream tool — Cargo AI via the bundled `cargo-ai` CLI; Pydantic AgentSpec
  via the real `pydantic-ai` library in a bundled Python venv. The Rust API
  no longer hand-rolls provider calls.
- **Markdown output.** Agent output renders as markdown by default.
- **Feedback → Improvement rename** everywhere (DB table, routes, UI copy).
  The PR-correlation marker `TAS-Feedback-ID:` is kept as a wire-format
  constant for back-compat with in-flight PRs.
- **`/agents/new` simplified.** Removed "From template" and "Paste
  definition" tabs; chat is the only path now. Lib code for the removed
  paths (`createAgentFromTemplate`, `createAgentFromContent`,
  `commitAgentFile`, starter renderers) dropped.
- **Base UI primitives.** New `Select` component built on `@base-ui/react`.
  `Badge` padding bumped, `Input` height bumped, framework label shortened
  to "Pydantic" / "Cargo AI".

### Scope moves
- **US-0.2-08 (event-driven triggers) → v0.3 US-15.** Depends on the
  Connections substrate v0.3 owns; building a one-off github-only
  webhook receiver in v0.2 would have been a snowflake.
- **US-0.2-06 (HITL pause/resume) → v0.3 US-13b.** Merges cleanly with
  v0.3's rich-HITL-forms work; splitting it across phases meant v0.3
  would have to immediately rewrite the v0.2 surface.
- **US-0.2-03/04 (PR policy) → backlog.** Blocked on the Tembo Coding
  Agent Platform shipping a direct-commit mode; today CAP always opens
  a PR, so there's no auto-merge surface to wire.

## [v0.1] — Foundation — shipped May 2026

The trustworthy floor: self-hosted deploy, identity, repo connection, runs.

### Added
- Docker-compose deploy: Next.js 16 web + Rust axum API + Postgres.
- Auth via better-auth + Google OAuth (email/password disabled, in-app
  instructions for swapping providers).
- GitHub OAuth repo connection — token stored AES-256-GCM-encrypted on the
  workspace row.
- Agents listed from the connected repo as a 3-column card grid (last run
  status, framework + model badges, search). Two framework families
  supported: **Pydantic AgentSpec** and **Cargo AI**, each under their own
  `agents/<framework>/` subfolder.
- Create-agent flow (from template or paste, with framework picker).
- Manual runs against Anthropic Claude (Opus / Sonnet / Haiku). Output
  streams to a run detail page with status, model, queued/started/duration,
  and token consumption + approximate cost.
- Soft-delete + restore for agents (commits to the repo on both ends;
  deletion record retained for audit).
- Per-workspace favicon picker (default set + custom upload).
- Theme picker in settings: System / Light / Dark mode toggle, eight
  built-in presets (Light, Paper, Pure Light, Dark, Midnight, Forest,
  Ember, Blackout), local-only persistence.
