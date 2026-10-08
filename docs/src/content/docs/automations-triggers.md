---
title: Automations & triggers
description: Run agents on a schedule or fire them from external events.
---

Beyond on-demand [runs](/agent-studio/running-agents/), agents can run on their
own — on a clock or in response to something happening.

## Automations (schedules)

An **automation** runs an agent on a recurring schedule. Create and manage them from
the **Automations** page. You pick the agent, the schedule, an optional input
message, and an **owner** — the automation runs as that owner, so it uses the
owner's [connection](/agent-studio/connections/) credentials. You can also choose
whether a schedule runs the agent's **stable** version or its live **draft**.

Use the **Schedule** picker to choose **Daily**, **Weekdays**, **Weekly**,
**Monthly**, **Every few hours**, or **Business hours**. Choose a time for daily, weekday, weekly,
and monthly schedules; weekly schedules let you check one or more days.
For monthly schedules, choose a day of the month. Months without that day are
skipped (for example, the 31st skips February). Hourly schedules run around the
clock from midnight, every 1, 2, 3, 4, 6, 8, or 12 hours, on the hour. The live
summary and next-run preview show what will happen before you save.

**Business hours** repeats on selected days within a same-day window. Choose an
interval, a **From** hour, a **Through** hour, and days of the week. For example,
every 2 hours from 09:00 through 17:00 on weekdays runs at 09:00, 11:00, 13:00,
15:00, and 17:00 Monday–Friday. The interval starts again at the From hour each
selected day. The end hour is included only if the interval lands on it; no run
occurs later. Times are on the hour; the end must be later than the start. Use
Advanced cron for overnight windows or minute offsets.

**Advanced cron** lets you enter a cron expression directly, including schedules
such as overnight windows or repeating minutes. Existing
expressions that the picker can represent open in the picker; other expressions
open in Advanced and are preserved unchanged. Switching modes does not rewrite
your expression. For a custom expression, **Start a new simple schedule** explicitly
replaces it with the weekday 9 AM default, which you can then adjust before saving.

New schedules created in the browser automatically save **your browser's
timezone** (for example, `America/New_York`), including suggested automations.
Enter times in that timezone. In Advanced cron, `10 8 * * 1-5` means weekdays at 8:10 AM.
The **Timezone** selector defaults to your browser's timezone and can be overridden,
for example with `America/New_York` for Eastern or `America/Chicago` for Central.
The form and schedule lists show the saved timezone.
Schedules follow local daylight saving changes, so an 8:10 AM schedule stays at
8:10 AM year-round. A daily time in the skipped spring-forward hour moves ahead
by the DST gap (for example, 2:30 AM becomes 3:30 AM in New York); a daily time
in the repeated fall-back hour fires once, at its first occurrence. The next-fire timestamp is displayed in the viewer's local time.

Editing, pausing, re-enabling, or changing the run-as owner preserves the saved
timezone, even from a browser in another timezone, unless you explicitly change
**Timezone**. Changing it keeps the selected clock times, so the actual run
instant changes; review the next-run preview before saving. The timezone comes from the
creator's browser, not the run-as person's location. Existing schedules and new
schedules created through the API or MCP continue to use UTC. To move an existing
UTC schedule to local time, edit its timezone and adjust the clock time as needed. API responses include
`timezone` so clients can interpret the cron correctly.

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
**Action needed** in the sidebar. **An error does not disable the schedule.** A
run that fails after it has been queued also does not stop future scheduled runs.
Disabled schedules and schedules paused for a missing owner do not fire.

- **Temporary repository failures and run API HTTP 429/5xx responses** retry
  automatically after 30 seconds, then 1, 2, 4, and 8 minutes, up to a maximum
  delay of 15 minutes between attempts. The scheduled window remains due until
  a run is queued. Missed windows are coalesced into one catch-up run rather
  than replayed individually. Restarting the scheduler preserves the due window
  but resets its in-memory backoff.
- **Configuration failures**, such as an invalid repository token, deleted
  agent, or non-retryable run API response, are checked again at the next natural
  cron firing. Fix the reported problem; a manual run is not required to restore
  scheduling.
- **Run API transport failures** are also retried at the next natural cron
  firing, not immediately. A lost response may mean the API already queued the
  run, so TAS does not immediately replay that ambiguous request.

Errors remain visible until a run is successfully queued. Editing or resaving
an automation does not mark the error resolved. Dispatch history includes the
failure details and whether the schedule will retry automatically.

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
2. **Webhook delivery** — under **Settings → Composio → Event delivery**, a
   workspace admin can choose **Configure delivery** to register the workspace
   URL and save its signing secret. The instance must have a public HTTPS
   `BETTER_AUTH_URL`. A project already delivering to another URL is left unchanged.
   Alternatively, register the displayed URL (`/api/hooks/composio/{workspace}`)
   in the same Composio project as the API key, subscribe to
   `composio.trigger.message`, and paste that subscription's signing secret
   into TAS. Saving an API key and secret alone does **not** register delivery.
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

### When a trigger stays at Never fired

A workspace admin can use **Settings → Composio → Check delivery** to check the
remote webhook URL, trigger-event subscription, and signing-secret match (when
Composio returns the secret). It also lists each local trigger's Composio ID and
whether that instance is enabled, disabled, or missing in the current Composio
project. A failed remote check is reported as unavailable, not as a missing trigger.

Use **Configure delivery** to add a missing workspace subscription or enable
trigger events on its existing subscription. If Composio does not return the
signing secret, copy it manually from that subscription in the Composio dashboard.
Composio currently allows one subscription per project. If the project already
delivers to another URL, setup stops without changing it. Use a separate
Composio project for this workspace or review the destination in the dashboard.
Duplicate subscriptions for the same URL must also be resolved there first.

An enabled instance and correct delivery configuration do not prove that Composio
has detected an email. For Gmail, send a **new** matching message after enabling
`GMAIL_NEW_GMAIL_MESSAGE`, then inspect Composio's trigger logs and webhook
delivery attempts for the displayed trigger ID. Verify the Gmail connection and
query if no event is detected; inspect the destination URL, response status, and
signing secret if an event is detected but delivery fails. Once corrected, send
another matching message and confirm a run appears in TAS.

Empty TAS dispatch history does not prove that no HTTP requests arrived:
missing headers or invalid signatures are rejected before a trigger can be
identified, and unknown or wrong-workspace trigger IDs are ignored. Composio's
delivery log distinguishes those cases from no detection or no subscription.

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

### Searching scheduled-run identities

Schedule forms show the selected **Run as** identity immediately. Use the name or
email search to choose a different member; each search returns at most 25 choices.
If more match, narrow the search using an email address. The selected identity is
preserved while searching. Saving still checks that the selected user belongs to
the workspace. A schedule whose previous owner has left requires a current member
before it can be saved.
