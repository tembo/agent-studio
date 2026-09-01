---
title: Automations & triggers
description: Run agents on a schedule or fire them from external events.
---

Beyond on-demand [runs](/agent-studio/running-agents/), agents can run on their
own — on a clock or in response to something happening.

## Automations (schedules)

An **automation** runs an agent on a cron schedule. Create and manage them from
the **Automations** page. You pick the agent, the schedule, an optional input
message, and an **owner** — the automation runs as that owner, so it uses the
owner's [connection](/agent-studio/connections/) credentials. You can also choose
whether a schedule runs the agent's **stable** version or its live **draft**.

Schedules always require explicit creation. When a new-agent description names
a recurring cadence, TAS may suggest that cadence, but it does not create or
enable an automation automatically. Test the new agent first, then use **Create
suggested automation** to save the recommendation in a disabled state. Enable
it from the agent's **Automation** tab when it is ready to run unattended.

The automations list shows a **Run as** column so you can see whose credentials
each schedule uses. Open an automation to see its recent run history; every row
shows the effective **Run as** identity captured for that run, so reassignment
does not make older executions ambiguous.

Removing a workspace member includes an automation handoff step. An admin can
reassign every automation owned by that member, or leave the default **Pause
enabled schedules** choice. TAS also checks this invariant in the scheduler:
if an enabled schedule's owner is no longer a workspace member, the schedule is
paused before it can fire. Reassign the owner and re-enable the automation when
it is ready to run again.

If a schedule cannot start, its status changes to **Error** and it appears under
**Action needed** in the sidebar. Temporary failures while reading the connected
GitHub repository are retried with backoff; the scheduled window remains due so
TAS starts one catch-up run when the repository becomes available again. Errors
that require configuration changes, such as an invalid repository token or a
deleted agent, remain visible until a run is successfully queued. Editing or
resaving an automation does not mark the error resolved.

Open **Dispatch history** from the Automations page to inspect failures across
schedules, event triggers, and inbound webhooks. The history keeps the failure
timestamp and retry attempt after an automation recovers, and records the first
successful recovery with a link to its run. Error summaries are safe for every
workspace member. Workspace admins additionally see a collapsed **Technical
details** section containing sanitized diagnostics; raw provider responses and
credentials are never stored there.

## Composio event triggers

A **trigger** fires an agent from an external event — a new Gmail message, a
GitHub PR event, and so on — via Composio. Triggers are configured **per agent**
on the agent detail page, in the **Triggers** section (above Automations).

### Prerequisites

1. **Composio API key** — set under **Settings → Composio**.
2. **Composio webhook secret** — also under **Settings → Composio**. Copy the
   webhook URL shown there (`/api/hooks/composio/{workspace}`) into your Composio
   app's webhook configuration, then paste the matching secret into TAS.
3. **A connection** — the acting user must have authorized the toolkit the
   trigger listens on (e.g. Gmail). Authorize it under
   [Connections](/agent-studio/connections/) first.

:::caution[Web tier must stay up]
Composio trigger webhooks terminate on the **web** service at
`/api/hooks/composio/{workspace}`. If the web tier sleeps (some serverless
plans) or scales to zero, event triggers pause until it's reachable again. See
your [deploy guide](/agent-studio/admin-introduction/) for platform-specific
notes.
:::

### Creating a trigger

On the agent detail page, under **Triggers → Add trigger**:

1. **Connection** — pick which authorized connection's credentials the trigger
   runs under (this sets the acting user).
2. **Composio trigger slug** — SCREAMING_SNAKE_CASE, e.g.
   `GMAIL_NEW_GMAIL_MESSAGE`. Find slugs in
   [Composio's trigger catalog](https://docs.composio.dev/triggers).
3. **Config (JSON)** — per-trigger configuration. Use `{}` when the trigger has
   no required fields.

TAS registers the subscription with Composio. When an event arrives, TAS verifies
the HMAC signature, looks up the trigger, and queues a run. Enable or disable
individual triggers from the same section without deleting them.

Like automations, an event run executes as the trigger's connection owner.

:::note
The owner/acting-user model is the same across manual runs, automations, and
triggers — it determines which credentials a run uses. See
[Core concepts → acting user](/agent-studio/core-concepts/).
:::

Each fired run shows up in [Runs](/agent-studio/dashboard-and-runs/) with
**Source = Event** so you can tell automated activity from hand runs.

## External webhooks

An **external webhook** lets any outside system fire an agent by POSTing to a
TAS URL — useful when the event source isn't a Composio toolkit. **Clay** is the
first-class example: Clay sends an enriched row to TAS, and the agent does the
work (e.g. upsert Attio, enroll a sequence).

Create one on the agent's detail page, under **External webhooks**:

1. **Add a webhook** with a name (and, as an admin, an owner to run as). TAS
   shows the **endpoint URL** and a **bearer token** — copy both now; the token
   is shown only once (rotate to issue a new one).
2. The caller POSTs to the URL with the token in an `Authorization: Bearer`
   header and a JSON body. TAS verifies the token, queues a run, and acks
   immediately (HTTP 202) — fire-and-forget. The agent receives the request body
   as its input (envelope: `{ "trigger_type": "webhook", "webhook": "<name>",
   "payload": <your JSON> }`), and its instructions + `tools_module` interpret
   the fields.

```bash
curl -X POST https://<your-tas>/api/hooks/webhook/<id> \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"email":"sam@acme.com","domain":"acme.com"}'
```

### Wiring it into Clay

In Clay, add an **HTTP API** column: method **POST**, the endpoint URL, a header
`Authorization: Bearer <token>` (Clay's encrypted "Headers account" is built for
this), and a JSON body mapped from your table columns. Clay fires a request per
row; each one queues a run.

The agent typically needs a [Secret](/agent-studio/connections/#secrets-api-keys)
or [connection](/agent-studio/connections/) to write results back (to Clay,
Attio, etc.) from its [Python tools](/agent-studio/sidecar-python-tools/) — the
webhook only starts the run.

Runs fired this way also appear in [Runs](/agent-studio/dashboard-and-runs/) as
**Event**. Bad/missing token → 401, a disabled webhook → 403, too many in a
short window → 429.
