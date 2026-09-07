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

## SMS opt-in (call to action)

Text-message channels provide request-initiated customer care. Agent Studio
does not send marketing texts or start unsolicited conversations.

### How members opt in

1. Sign in to your organization's Agent Studio workspace.
2. Open **Build → Text messages** and choose **Link this phone**.
3. Review the SMS consent disclosure shown beside the linking control.
4. Choose an enabled workspace number and send the displayed one-time `link`
   command from the mobile phone you want to connect.

Sending the link command proves control of the phone and completes opt-in. It
also links the phone to the authenticated workspace member. Linking once lets
the member use every enabled number in that workspace; they initiate each
conversation by texting the number they want to use.

### Consent wording shown to members

> By sending the one-time LINK command displayed in your Tembo Agent Studio
> workspace, you expressly agree to receive customer-care and service-related
> SMS text messages from Tembo at the mobile number from which you send the
> command. Messages may include phone-link confirmations, request
> acknowledgements, agent results, help responses, and service notices.
>
> Message frequency varies based on your activity; each agent request typically
> generates two messages—one acknowledgement and one result. Msg & data rates
> may apply. Reply STOP to opt out and HELP for help. Consent is not a condition
> of purchase. Tembo does not send marketing messages.

[Privacy Policy](https://www.tembo.io/privacy/privacy-policy) ·
[Terms](https://www.tembo.io/terms)

An unlinked phone cannot start an agent run. It may receive a single linking,
help, or carrier compliance response explaining how to proceed.

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
6. Keep Twilio's standard STOP filtering enabled. For customized STOP, START,
   and HELP confirmations, add the number to a Twilio Messaging Service and
   configure [Advanced Opt-Out](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out).
   If the Messaging Service uses the number's inbound webhook, keep the Agent
   Studio webhook configured on the number.
7. Each workspace member opens **Build → Text messages**, chooses an enabled
   number under **Your phone**, then texts the displayed one-time `link`
   command from their phone. Linking once enables that phone on every text
   number in the workspace.
8. Send the Twilio number a request. TAS immediately acknowledges a routed request
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

Text `agents` or `list` to receive the connected-agent directory. `HELP` is
reserved for SMS help and compliance information and is never routed to an
agent. TAS also returns the agent directory instead of starting a run when no
agent clearly fits, a request is ambiguous, or natural-language routing is
unavailable.

## Example message flow

The exact agent names and result content depend on the workspace. A typical
conversation looks like this:

```text
Member: link 0123456789ABCDEF
Agent Studio: Phone linked. Send AGENTS to see the available agents.

Member: support-triage summarize ticket 42
Agent Studio: support-triage is working on it. I'll text the result shortly.
Agent Studio: Ticket 42 is waiting on customer confirmation…
```

Each agent request typically produces two messages: an immediate
acknowledgement and the eventual result. Linking, help, validation errors, and
carrier compliance commands may produce an additional message. Agent Studio
does not send recurring or marketing messages.

### STOP, START, and HELP

Twilio handles standard opt-out and opt-in keywords at the provider layer.
Agent Studio reserves Twilio's standard STOP and START keyword sets so they can
never be interpreted as agent requests. When Advanced Opt-Out sends an
`OptOutType` webhook, Agent Studio returns no additional message because Twilio
has already sent the configured confirmation.

If Twilio has not already handled `HELP`, Agent Studio replies:

```text
Tembo Agent Studio: Text AGENTS for agent list. Help: tembo.io. Request replies
only. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out.
```

Recommended Advanced Opt-Out confirmations identify the sender and preserve
the same commands used in the disclosure:

- **Opt-out:** “Tembo Agent Studio: You have opted out and will receive no more
  messages from this number. Reply START to resubscribe.”
- **Opt-in:** “Tembo Agent Studio: You are resubscribed. Reply HELP for help or
  STOP to opt out.”
- **Help:** Use the HELP response above.

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
- Standard opt-out, opt-in, and help keywords are reserved before member lookup
  or agent routing. Twilio remains the source of truth for its recipient block
  list.
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
