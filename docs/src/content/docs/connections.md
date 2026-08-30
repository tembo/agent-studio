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

Authorize and manage connections under **Connections**. If a credential expires
or is revoked, the connection is marked stale and runs that need it fail with a
clear message — reconnect from the same page. Reconnecting a Native MCP account
normally reuses its existing registered OAuth client instead of consuming
another provider registration. If a provider rate-limits a first-time
connection, wait and retry later. See
[Troubleshooting](/agent-studio/troubleshooting/).

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
For these, use a **Secret**: a free-form, **workspace-level** key an admin sets
once under **Connections → Secrets** and the whole workspace shares (unlike the
per-user OAuth connections above). Secrets are read by an agent's
[sidecar Python tools](/agent-studio/sidecar-python-tools/) via
`tas_tools.secret("name")` — they attach no tools and are invisible to the
model.

- **Add one** (admin): Connections → Secrets → name (e.g. `clay`) + value. It's
  encrypted at rest and shown masked.
- **Use it** in a tool: `tas_tools.secret("clay")` returns the value.
- **Optionally declare it** on the agent so the studio prompts an admin to set a
  missing one:

  ```yaml
  connections:
    - { type: clay, source: secret }
  ```
