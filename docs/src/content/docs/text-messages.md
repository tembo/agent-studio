---
title: Text messages
description: Connect a Twilio phone number so people can run label-scoped agents over SMS.
---

Agent Studio can connect one **Twilio SMS number** to a label-scoped set of
agents in each workspace. A person texts the number, TAS routes the request to
one of those agents, launches its current stable version, and Twilio sends the
result back to the originating phone.

## Set up the channel

Only a workspace admin can configure text messages.

1. In Twilio, buy or select an SMS-capable phone number.
2. In TAS, open **Build → Text messages**.
3. Enter the Twilio **Account SID**, **Auth Token**, and phone number in E.164
   form (for example, `+14155550123`).
4. Add the phone numbers that may send requests. Unlisted senders receive no
   response and cannot start a run.
5. Enter one or more **agent labels** as a comma-separated list. Every valid
   agent carrying at least one of those labels is connected to the number.
   Choose the workspace member the runs should act as, then save.
6. Copy the webhook URL TAS reveals. In Twilio's phone-number configuration,
   set **A message comes in** to **Webhook**, paste the URL, choose **HTTP POST**,
   and save.
7. Send the Twilio number a text. TAS immediately acknowledges a routed request
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

Phone numbers are not TAS identities. Every SMS run acts as the **Run as**
member selected by the admin and uses that member's connections. Choose a
service account or another member whose permissions fit what the SMS agent may
do.

The channel runs the routed agent's **stable version**, matching other
unattended entry points. Promote a draft before expecting text messages to use
it. Changing labels in an agent spec can connect or disconnect that agent from
the number without changing the text-message channel.

## Security and limits

- Only explicitly allowed E.164 sender numbers can invoke the agent. Still
  treat the number as an external entry point and give the agent narrowly
  scoped tools.
- TAS verifies every inbound request with Twilio's `X-Twilio-Signature` and
  ignores repeated `MessageSid` deliveries.
- The Twilio Auth Token is AES-256-GCM encrypted at rest and is never shown
  again. Leave the token field blank when editing to keep the existing value.
- Each sender can start at most 10 runs per minute on the channel.
- Outbound agent replies are limited to 1,500 characters and receive a
  truncation marker when longer. Carrier segmentation and Twilio messaging
  charges still apply.

Disable **Accept incoming text messages** to pause the channel without deleting
its settings. Remove the channel to delete its credentials and delivery
history.

## Observability

SMS-launched runs appear under **Runs** with **Source = Text** and the configured
Twilio number. Each launch also records an `sms.dispatch` audit event. The run's
status remains independent from SMS delivery: a successful agent run can still
have a provider delivery error, which the runner records on the delivery row.
