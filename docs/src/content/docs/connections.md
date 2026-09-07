---
title: Connections
description: Authorize external services so agents can act on them — Composio and Native MCP, authorized per user.
---

**Connections** are how agents reach outside services — Slack, Gmail, Google
Sheets, Notion, Attio, GitHub, and ~1,000 more. An agent declares what it needs
in its `connections:` field; each operator authorizes the accounts their runs
act as.

## Per-user authorization

Connections are authorized **per user, per workspace**. Because a run executes as
a specific [acting user](/agent-studio/core-concepts/), it uses that user's
authorized accounts. A manual run uses yours; a scheduled run uses the
automation owner's; an event run uses the trigger owner's. If an agent needs a
service nobody has connected, the sidebar surfaces an **"Action needed"** prompt
with a **Connect** button.

## Three substrates

| Substrate      | When to pick it                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| **Composio**   | The default. ~1,000 services wrapped as REST tools. Lowercase slugs (`slack`, `googlesheets`).                  |
| **Native MCP** | The provider has an official MCP server — richer, schema-aware tools, fewer round trips, and TAS-managed OAuth. |
| **Secrets**    | A plain **API key** for a service with no OAuth (e.g. Clay), read by [sidecar Python tools](/agent-studio/sidecar-python-tools/). |

Prefer **Native MCP** when the provider is in TAS's native catalog (below): it
uses the provider's official server with richer, schema-aware tools. Most native
providers use **TAS-managed OAuth** (just click **Connect**); a couple are
**bring-your-own OAuth app**. Use **Composio** for anything not in the native
catalog.

:::caution[Slugs differ between substrates]
The tool slugs for the same provider differ between Composio and Native MCP. If
you switch a connection's `source:`, update the agent's `tools:` list to match.
:::

### Native MCP catalog

TAS ships native MCP support for these providers:

| Provider | Auth |
| --- | --- |
| Attio, Pylon, Fathom, Dialed, Linear, Amplemarket, Clay, Avoma, Metabase, Notion, Intercom, Atlassian (Jira), Asana, monday.com, Guru, Fireflies, Amplitude, Apollo, PostHog, Stripe, Vercel, Canva, ClickUp, Close, Sentry, Mixpanel, Granola, Dropbox, Webflow, Cloudflare, Neon, Cal.com, Klaviyo, PayPal, Square, Airtable, Railway, Resend, Hex, Pendo, Similarweb, Datadog, Common Room, Outreach, Salesloft, ZoomInfo, Lusha, Hunter, Instantly, Crossbeam, Harmonic, Chili Piper, Day AI, Clarify, Staircase AI, Zendesk, Help Scout, Gorgias, Plain, Lorikeet, Unthread, Enterpret, Dovetail, Missive, Otter.ai, Grain, Krisp, Circleback, tl;dv, Ramp, Brex, Mercury, Expensify, Navan, Carta, Digits, GoCardless, Mercado Pago, PitchBook, Morningstar, CB Insights, Quartr, Daloopa, Consensus, Gusto, Deel, Ashby, Workable, Metaview, Indeed, Udemy Business, SignNow, Vanta, Drata, Figma, Miro, Lucid, Productboard, Aha!, Shortcut, Todoist, Teamwork, Calendly, Superhuman Mail, Craft, Mem, Gamma, Pitch, Eraser, Jotform, Typeform, SurveyMonkey, Egnyte, Mailchimp, Customer.io, Ahrefs, Semrush, Cloudinary, Contentful, Sanity, Wix, WordPress.com, GitBook, Mintlify, DeepL, GitLab, Supabase, Netlify, Heroku, Buildkite, Grafana, New Relic, Honeycomb, incident.io, Rootly, BugSnag, LaunchDarkly, PlanetScale, Prisma Postgres, InstantDB, Algolia, Statsig, Postman, Semgrep, WorkOS, Stytch, Mux, Knock, Lovable, Retool, Telnyx, Jam, Globalping, Airbyte, MotherDuck, Monte Carlo, Atlan, Hugging Face, Zapier, Make, IFTTT, Exa, Tavily, Firecrawl, Apify, Bright Data | **TAS-managed OAuth** — click **Connect**, authorize, done |
| GitHub, X, Render | **API token** — paste a PAT (GitHub), App-only Bearer (X), or API key (Render) |
| HubSpot, Gmail, Slack, Gong, Box, PagerDuty, Zoom, DocuSign, Xero, Front, Smartsheet, MongoDB Atlas, CircleCI, Chargebee, BigQuery, Ironclad, Harvey, Tableau, Shopify | **Bring-your-own OAuth app** — admin sets up once (below) |

There's also a built-in **Tembo Agent Studio** native connection (TAS's own MCP
server) that agents use to read/produce [Tasks Inbox](/agent-studio/tasks-inbox/)
items and trigger other runs.

### Optional Tembo Memory

An instance admin can connect a Memory server by setting `TAS_MEMORY_URL` (the
server origin, not `/mcp`) and `TAS_MEMORY_ADMIN_TOKEN` on the **API service only**.
Leave both unset to disable the integration. The web app and agent subprocesses
never receive the Memory admin credential. Memory must include workspace APIs and
short-lived agent keys; use its `MEMORY_BOOTSTRAP_TOKEN` as the controller token.

Every Pydantic agent then receives `memory_ask`, `memory_search`, `memory_entities`,
and `memory_report` automatically, without a `connections:` entry. Cargo AI is
unchanged. The managed connection replaces a manually declared `tembo-memory`
connection; its tool names are reserved for the integration.

Under **Workspace Settings → General → Memory**, an instance admin who belongs to
the workspace can select its Memory workspace. The default is a dedicated workspace
created lazily on first upstream use. Selecting an existing one deliberately shares
its internal knowledge with agents here. Several Studio workspaces can select the
same Memory workspace. Ordinary workspace admins cannot change this cross-workspace
sharing boundary. Agent identity includes the originating Studio workspace, stable
agent name, and acting user, even when the target Memory workspace is shared.

Studio calls Memory's HTTP API through a managed MCP bridge. It obtains one-hour,
internal-sensitivity agent credentials on the server; it does not grant agents
Memory admin rights. Credentials are renewed without changing the filing identity.
Within the selected workspace, agents can read internal claims across account
scopes, but cannot read higher-sensitivity claims.

#### Outages and queued reports

Memory outages do not fail runs. Reads return an explicit unavailable result, not
an empty knowledge answer. `memory_report` first commits an encrypted report to
Studio's Postgres outbox and returns a **queued receipt**. If that commit fails,
the tool says it was not queued; it never claims a successful save.

A background worker retries delivery automatically with backoff, including after
Studio restarts and when the original agent never runs again. The original event
time, source, filing principal and replay identifier are preserved. If Memory accepts
a report but its response is lost, retry retrieves that same report. Delivered means
accepted for extraction, not that claims are already available. Payload content is
removed from the outbox after acknowledgement; receipt metadata remains.

Workspace settings show queue counts and sanitized blocked-item errors. Run pages
show report status and Memory warnings; refresh to see delivery after a run finishes.
Instance admins can retry blocked reports after fixing authorization/configuration.
Removing/demoting the acting user or disabling the integration blocks pending
delivery. Reports are never silently moved to a different destination when a mapping
or server URL changes: mapping changes affect new runs, existing receipts retain
their original target, and changing the server URL blocks old receipts for review.

Dry runs may read Memory but never enqueue or deliver new reports. No prompts or
routine outputs are copied automatically. Reports are limited to 64 KiB; prefer
durable facts and source pointers. Use the same `external_id` for retries of the
same source item. Memory bootstrap credentials, protected workspaces, and sealing
remain under the Memory administrator's control; sealed workspaces retain pending
reports until ready.

:::note[Gmail is in Google's Developer Preview]
The Gmail MCP server (`gmailmcp.googleapis.com`) is gated behind the Google
Workspace Developer Preview Program — even with the OAuth app + scopes set up,
tool calls are denied until your Workspace org is enrolled. Until then, connect
Gmail through **Composio** instead.
:::

### Bring-your-own OAuth app (Manage providers)

A few native providers (HubSpot, Gmail) need a confidential OAuth app you create
in *their* console — TAS can't self-register one. A **workspace admin** sets this
up once, then everyone connects normally:

1. **Connections → Manage providers** → find the provider's card.
2. Create an OAuth app in the provider's console (the card links to its guide).
   Register the **redirect URI shown on the card** and grant the scopes it lists
   (e.g. Gmail needs the Gmail API + Gmail MCP API enabled and the
   `https://mail.google.com/` scope).
3. Paste the app's **client ID + secret** into the card, then **enable** the
   provider with its toggle.
4. Members can now **Connect** it from the normal connect flow.

Until an admin does this, a bring-your-own provider doesn't appear in the connect
list — it shows *"needs an OAuth app first."*

## Declaring connections on an agent

```yaml
connections:
  - { type: slack, tools: [SLACK_SEND_MESSAGE] }
  - { type: attio, source: native-mcp, name: default, tools: [run-basic-report] }
```

- `type:` is the provider slug.
- `source:` defaults to `composio`; set `native-mcp` for native providers.
- `name:` is the connection slot ("default" unless you keep multiple accounts of
  the same provider, e.g. `work` vs `personal`).
- `tools:` narrows what the agent can call (works on both substrates).

## Authorizing and reconnecting

Authorize and manage connections under **Connections**. Native MCP OAuth tokens
refresh automatically shortly before they expire. Rotating refresh tokens are
stored atomically, and temporary authorization-service failures are retried
without requiring you to reconnect.

When a refresh is temporarily unavailable, the connection shows **Retrying**
and its detail page shows when another attempt is allowed. If consent was
revoked, the refresh grant is no longer supported, or the OAuth application is
invalid, the connection is marked **Stale** or **Revoked** with a safe reason
and a **Reconnect** action. Runs that require one of those connections are
blocked with the same actionable reason. Token values and provider response
bodies are never shown in the health message.

Reconnecting a Native MCP account normally reuses its existing registered OAuth
client instead of consuming another provider registration. If a provider
rate-limits a first-time connection, wait and retry later.

See [Troubleshooting](/agent-studio/troubleshooting/).

### Viewing another member's connections (admins)

Workspace admins see a **Viewing** dropdown at the top of the Connections page.
Switch it to inspect another member's authorized accounts. When viewing someone
else you can **Rename** and **Refresh** their connections; **Connect**,
**Reconnect**, and **Disconnect** are hidden because OAuth must be performed by
that member themselves.

Use this together with the [member detail view](/agent-studio/dashboard-and-runs/#member-detail-admins)
when troubleshooting "no active connection" failures for automations or triggers
that run as a specific owner.

For doing deterministic I/O over a connection from Python, see
[Sidecar Python tools](/agent-studio/sidecar-python-tools/).

## Secrets (API keys)

Some services — like Clay — authenticate with a plain **API key**, not OAuth.
For these, use a **Secret**: a free-form key stored under **Connections →
Secret / API key**. Operators can add a personal secret; workspace admins can
also add a workspace-wide shared secret. Secrets are read by an agent's
[sidecar Python tools](/agent-studio/sidecar-python-tools/) via
`tas_tools.secret("name")` — they attach no tools and are invisible to the
model.

- **Add one**: Connections → New connection → Secret / API key → name (e.g.
  `clay`) + value. Workspace admins choose **Me** or **Workspace**; operators
  create personal secrets. Values are encrypted at rest and shown masked.
- **Use it** in a tool: `tas_tools.secret("clay")` returns the value.
- **Resolution**: a run uses the acting user's personal value first. When they
  do not have one with that name, it falls back to the shared workspace value.
  Other members cannot see or manage a personal secret.
- **Optionally declare it** on the agent so the studio prompts an admin to set a
  missing one:

  ```yaml
  connections:
    - { type: clay, source: secret }
  ```
