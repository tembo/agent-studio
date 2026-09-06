import { NextResponse, type NextRequest } from "next/server";

import { postMessage, publishHomeView } from "@/lib/slack-api";
import {
  buildHomeView,
  dispatchToAgent,
} from "@/lib/slack-dispatch";
import { authenticateSlackRequest } from "@/lib/slack-inbound";
import {
  claimSlackEvent,
  listAgentsForSlackApp,
  type SlackApp,
} from "@/lib/slack-apps";
import { classifyMessage, parseAgentMessage } from "@/lib/message-router";
import { getWorkspaceSecretPlaintext } from "@/lib/workspace";

// Events API endpoint. Handles the one-time url_verification handshake
// (pre-install, no bot token), then app_mention + message.im events.
// We ack 200 immediately and dispatch out of band — Slack retries any
// response slower than 3s, and a fast ack avoids duplicate fires.

export const dynamic = "force-dynamic";

type RouteParams = Promise<{ appId: string }>;

type SlackEvent = {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  /** app_home_opened: which tab the user opened ("home" | "messages"). */
  tab?: string;
};

type EventEnvelope = {
  type?: string;
  challenge?: string;
  /** Stable id for the delivery; identical across Slack's retries. */
  event_id?: string;
  event?: SlackEvent;
};

export async function POST(
  request: NextRequest,
  { params }: { params: RouteParams },
): Promise<NextResponse> {
  const { appId } = await params;
  const auth = await authenticateSlackRequest(request, appId);
  if (!auth.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: auth.status });
  }
  const { app, botToken, rawBody } = auth;

  let body: EventEnvelope;
  try {
    body = JSON.parse(rawBody) as EventEnvelope;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  // Slack's URL-ownership handshake — happens during setup, before install.
  if (body.type === "url_verification" && body.challenge) {
    return NextResponse.json({ challenge: body.challenge });
  }

  // Everything past here needs the bot token (to reply). Ack regardless so
  // Slack stops retrying.
  if (!botToken) return new NextResponse(null, { status: 200 });

  const event = body.event;
  if (event) {
    const eventId = body.event_id;
    void (async () => {
      // Replay guard: a Slack retry carries the same event_id. Claim it
      // first; if it's already been handled, skip to avoid a double run.
      if (eventId && !(await claimSlackEvent(app.id, eventId))) return;
      await handleEvent(app, botToken, event);
    })();
  }

  return new NextResponse(null, { status: 200 });
}

// Strip leading "<@U123>" mention tokens an app_mention carries before the
// actual "<agent> <input>".
function stripMentions(text: string): string {
  return text.replace(/^(?:\s*<@[^>]+>)+/, "").trim();
}

// The workspace's Anthropic key powers the NL router. Absent → no routing
// (the caller falls back to the menu); never throws on a missing key.
async function getAnthropicKey(workspaceId: string): Promise<string | null> {
  try {
    return await getWorkspaceSecretPlaintext(workspaceId, "anthropic_api_key");
  } catch {
    return null;
  }
}

async function handleEvent(
  app: SlackApp,
  botToken: string,
  event: SlackEvent,
): Promise<void> {
  // App Home tab opened → publish the agent directory for this user.
  if (event.type === "app_home_opened") {
    if (event.tab && event.tab !== "home") return;
    if (!event.user) return;
    const scoped = await listAgentsForSlackApp(app);
    await publishHomeView(botToken, event.user, buildHomeView(app.name, scoped));
    return;
  }

  // Ignore anything we sent, and message edits/joins/etc. (subtypes).
  if (event.bot_id) return;
  const isMention = event.type === "app_mention";
  // Inside a thread, hand the surface to whatever custom listener owns it (e.g. the
  // Composio Y/N reply-handler). 
  const isThreadReply = !!event.thread_ts && event.thread_ts !== event.ts;
  const isDirectMessage =
    event.type === "message" &&
    event.channel_type === "im" &&
    !event.subtype &&
    !isThreadReply;
  if (!isMention && !isDirectMessage) return;

  const channel = event.channel;
  if (!channel || !event.user) return;
  // Reply in-thread: under the mention, or under the DM message.
  const threadTs = event.thread_ts ?? event.ts ?? null;

  const text = stripMentions(event.text ?? "");
  const { agentName } = parseAgentMessage(text);

  const scoped = await listAgentsForSlackApp(app);
  const matched = agentName
    ? scoped.find((a) => a.name === agentName)
    : undefined;

  // Decide the dispatch text. An explicit `<agent> …` uses the raw text.
  // Otherwise — a conversational message like "summarize last week's
  // tickets" — ask the natural-language router to pick an agent + task.
  let dispatchText: string | null = matched ? text : null;
  if (!matched && scoped.length > 0 && text.trim()) {
    const apiKey = await getAnthropicKey(app.workspaceId);
    if (apiKey) {
      const picked = await classifyMessage({
        apiKey,
        agents: scoped,
        message: text,
      });
      if (picked.agentName) {
        dispatchText = `${picked.agentName} ${picked.input}`.trim();
      }
    }
  }

  // Nothing resolved (greeting, bare mention, or the router declined) —
  // events carry no trigger_id so we can't open the picker; show the menu.
  if (!dispatchText) {
    const reply =
      scoped.length === 0
        ? "No agents are assigned to this bot yet. An admin can scope it in TAS → Settings → Slack apps: give the bot one or more labels, then add a matching `labels:` line to an agent."
        : `Tell me which agent to run, e.g. \`${scoped[0].name} do the thing\`. I can launch:\n${scoped
            .map((a) => `• \`${a.name}\``)
            .join("\n")}`;
    await postMessage(botToken, {
      channel,
      thread_ts: threadTs ?? undefined,
      text: reply,
    });
    return;
  }

  const result = await dispatchToAgent({
    app,
    botToken,
    slackUserId: event.user,
    text: dispatchText,
    channel,
    threadTs,
  });
  const message = result.ok
    ? `:rocket: Launched *${result.agentName}* as ${result.actingAs}. I'll post the result here when it's done.`
    : `:warning: ${result.message}`;
  await postMessage(botToken, {
    channel,
    thread_ts: threadTs ?? undefined,
    text: message,
  });
}
