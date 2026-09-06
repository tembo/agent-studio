---
title: Text messages
description: Connect Twilio phone numbers so people can run label-scoped agents over SMS.
---

Agent Studio can connect multiple named **Twilio SMS numbers** to a workspace.
Each number has its own credentials and label-scoped set of agents, similar to
having multiple Slack apps for different teams. A person texts a number, TAS
routes the request to one of its connected agents, launches the current stable
version, and Twilio sends the result back to the originating phone. Each
workspace member links their own phone once, so runs on every workspace number
act as that member and use their connections.

## Set up a text number

Only a workspace admin can configure text messages.

1. In Twilio, buy or select an SMS-capable phone number.
2. In TAS, open **Build → Text messages** and choose **New text number**.
3. Give the number a recognizable name, then enter the Twilio **Account SID**,
   **Auth Token**, and phone number in E.164 form (for example,
   `+14155550123`).
4. Enter one or more **agent labels** as a comma-separated list. Every valid
   agent carrying at least one of those labels is connected to the number.
5. Copy the webhook URL TAS reveals. In Twilio's phone-number configuration,
   set **A message comes in** to **Webhook**, paste the URL, choose **HTTP POST**,
   and save.
6. Each workspace member opens **Build → Text messages**, chooses an enabled
   number under **Your phone**, then texts the displayed one-time `link`
   command from their phone. Linking once enables that phone on every text
   number in the workspace.
7. Send the Twilio number a request. TAS immediately acknowledges a routed request
   and sends a second message with the agent's result when the run finishes.

The TAS host must be publicly reachable over HTTPS, and `BETTER_AUTH_URL` must
match that public origin. Twilio signs the exact webhook URL, so a proxy origin
that differs from `BETTER_AUTH_URL` causes requests to be rejected.

## Routing a text

Text the agent name followed by its request to route explicitly:

```text
support-triage summarize ticket 42
```

Agent names match without regard to capitalization. TAS removes the name and
passes the rest of the text to that agent. When only one agent is connected to
the number, every non-command text routes directly to it.

Otherwise, a text that does not begin with an agent name uses a lightweight
classifier to choose the best-fit connected agent. Give each agent a clear
`description:` to make this routing reliable. Natural-language routing requires
an Anthropic API key under **Settings → LLM Providers**; explicit agent-name
routing continues to work without that key.

Text `help`, `agents`, or `list` to receive the connected-agent directory. TAS
also returns that directory instead of starting a run when no agent clearly
fits, a request is ambiguous, or natural-language routing is unavailable.

## Identity and connections

The phone that sends a text determines the acting TAS member. Linking starts
from an authenticated Agent Studio session and finishes when the member sends a
single-use code from that phone. Codes expire after 15 minutes. A phone can
identify only one member within a workspace, though the same member can link
that phone independently in another workspace.

Every SMS run uses the linked member's connections. Removing the member from
the workspace immediately removes their text access through the membership
cascade. Members can unlink their own phone from **Build → Text messages**. The
link is workspace-wide: adding another text number does not require members to
link again.

The channel runs the routed agent's **stable version**, matching other
unattended entry points. Promote a draft before expecting text messages to use
it. Changing labels in an agent spec can connect or disconnect that agent from
the number without changing the text-message channel.

## Security and limits

- Only phones linked by current workspace members can invoke an agent. Unknown
  numbers cannot start runs. Still treat each text number as an external entry
  point and give agents narrowly scoped tools.
- TAS verifies every inbound request with Twilio's `X-Twilio-Signature` and
  ignores repeated `MessageSid` deliveries.
- The Twilio Auth Token is AES-256-GCM encrypted at rest and is never shown
  again. Leave the token field blank when editing to keep the existing value.
- Each sender can start at most 10 runs per minute on the channel.
- Outbound agent replies are limited to 1,500 characters and receive a
  truncation marker when longer. Carrier segmentation and Twilio messaging
  charges still apply.

Disable **Accept incoming text messages** to pause a number without deleting
its settings. Delete a text number to remove its credentials and delivery
history without affecting the workspace's other numbers or member phone links.

## Observability

SMS-launched runs appear under **Runs** with **Source = Text** and the configured
Twilio number. Each launch also records an `sms.dispatch` audit event. The run's
status remains independent from SMS delivery: a successful agent run can still
have a provider delivery error, which the runner records on the delivery row.
