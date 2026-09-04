---
title: Text messages
description: Connect a Twilio phone number so people can run an agent over SMS.
---

Agent Studio can connect one **Twilio SMS number** to one agent in each
workspace. A person texts the number, TAS launches the agent's current stable
version, and Twilio sends the result back to the originating phone.

## Set up the channel

Only a workspace admin can configure text messages.

1. In Twilio, buy or select an SMS-capable phone number.
2. In TAS, open **Build → Text messages**.
3. Enter the Twilio **Account SID**, **Auth Token**, and phone number in E.164
   form (for example, `+14155550123`).
4. Add the phone numbers that may send requests. Unlisted senders receive no
   response and cannot start a run.
5. Choose the agent that should answer every text and the workspace member the
   runs should act as, then save.
6. Copy the webhook URL TAS reveals. In Twilio's phone-number configuration,
   set **A message comes in** to **Webhook**, paste the URL, choose **HTTP POST**,
   and save.
7. Send the Twilio number a text. TAS immediately acknowledges the request and
   sends a second message with the agent's result when the run finishes.

The TAS host must be publicly reachable over HTTPS, and `BETTER_AUTH_URL` must
match that public origin. Twilio signs the exact webhook URL, so a proxy origin
that differs from `BETTER_AUTH_URL` causes requests to be rejected.

## Identity and connections

Phone numbers are not TAS identities. Every SMS run acts as the **Run as**
member selected by the admin and uses that member's connections. Choose a
service account or another member whose permissions fit what the SMS agent may
do.

The channel runs the selected agent's **stable version**, matching other
unattended entry points. Promote a draft before expecting text messages to use
it.

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
