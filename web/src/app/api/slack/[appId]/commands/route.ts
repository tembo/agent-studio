import { NextResponse, type NextRequest } from "next/server";

import { openView, postResponseUrl } from "@/lib/slack-api";
import {
  buildPickerView,
  dispatchToAgent,
} from "@/lib/slack-dispatch";
import { parseAgentMessage } from "@/lib/message-router";
import { authenticateSlackRequest } from "@/lib/slack-inbound";
import { listAgentsForSlackApp } from "@/lib/slack-apps";

// Slash command endpoint: `/tas <agent> <input>`. Slack POSTs an
// application/x-www-form-urlencoded body and expects a response within
// ~3s. We verify the signature, then:
//   - no agent named  → open the picker modal (needs the fresh trigger_id)
//   - agent named     → ack immediately, dispatch async, deliver the
//                       outcome to response_url (the run's *result* posts
//                       back later via the slack_delivery path).

export const dynamic = "force-dynamic";

type RouteParams = Promise<{ appId: string }>;

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
  if (!botToken) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "This bot isn't fully installed yet. An admin can finish setup in TAS → Settings → Slack apps.",
    });
  }

  const form = new URLSearchParams(rawBody);
  const text = form.get("text") ?? "";
  const userId = form.get("user_id") ?? "";
  const channel = form.get("channel_id") ?? "";
  const triggerId = form.get("trigger_id") ?? "";
  const responseUrl = form.get("response_url") ?? "";

  const { agentName } = parseAgentMessage(text);

  // No agent named → open the picker (the trigger_id expires in ~3s, so
  // this must happen inside the request, not deferred).
  if (!agentName) {
    const scoped = await listAgentsForSlackApp(app);
    if (scoped.length === 0) {
      return NextResponse.json({
        response_type: "ephemeral",
        text: "This bot has no agents assigned yet. An admin can scope agents to it in TAS → Settings → Slack apps.",
      });
    }
    await openView(
      botToken,
      triggerId,
      buildPickerView(scoped, { channel, threadTs: null }),
    );
    return new NextResponse(null, { status: 200 });
  }

  // Agent named → dispatch out of band, ack now. The run's result is
  // delivered to the thread later; here we just confirm it launched.
  void (async () => {
    const result = await dispatchToAgent({
      app,
      botToken,
      slackUserId: userId,
      text,
      channel,
      threadTs: null,
    });
    const message = result.ok
      ? `:rocket: Launched *${result.agentName}* as ${result.actingAs}. I'll post the result here when it's done.`
      : `:warning: ${result.message}`;
    if (responseUrl) await postResponseUrl(responseUrl, { text: message });
  })();

  return new NextResponse(null, { status: 200 });
}
