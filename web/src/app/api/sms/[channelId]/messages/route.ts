import { NextResponse, type NextRequest } from "next/server";

import { writeAuditEvent } from "@/lib/audit-db";
import { getPublicOrigin } from "@/lib/config";
import { classifyMessage, matchExplicitAgent } from "@/lib/message-router";
import { dispatchSmsToAgent } from "@/lib/sms-dispatch";
import {
  claimSmsEvent,
  getSmsAuthToken,
  getSmsChannelById,
  getSmsMemberByPhone,
  linkSmsPhoneWithCode,
  listAgentsForSmsChannel,
} from "@/lib/sms-channel";
import { verifyTwilioRequest } from "@/lib/twilio-verify";
import { getWorkspaceSecretPlaintext } from "@/lib/workspace";

export const dynamic = "force-dynamic";

type RouteParams = Promise<{ channelId: string }>;
const E164 = /^\+[1-9]\d{7,14}$/;

function twiml(message?: string): NextResponse {
  const escaped = message
    ?.replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
  const body = escaped
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
  return new NextResponse(body, {
    status: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

function agentMenu(agents: { name: string }[]): string {
  const visible = agents.slice(0, 20).map((agent) => agent.name);
  const suffix = agents.length > visible.length ? `, and ${agents.length - visible.length} more` : "";
  return `Available agents: ${visible.join(", ")}${suffix}. Text "<agent> <request>", or describe the task for automatic routing.`;
}

async function getRouterKey(workspaceId: string): Promise<string | null> {
  try {
    return await getWorkspaceSecretPlaintext(workspaceId, "anthropic_api_key");
  } catch {
    return null;
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: RouteParams },
): Promise<NextResponse> {
  const { channelId } = await params;
  const channel = await getSmsChannelById(channelId);
  if (!channel || !channel.enabled) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const [rawBody, authToken] = await Promise.all([
    request.text(),
    getSmsAuthToken(channel.id),
  ]);
  if (!authToken) {
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  const form = new URLSearchParams(rawBody);
  const webhookUrl = `${getPublicOrigin()}/api/sms/${channel.id}/messages`;
  const valid = verifyTwilioRequest({
    authToken,
    url: webhookUrl,
    params: form,
    signature: request.headers.get("x-twilio-signature"),
  });
  if (!valid) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const inboundSid = form.get("MessageSid")?.trim() ?? "";
  const from = form.get("From")?.trim() ?? "";
  const to = form.get("To")?.trim() ?? "";
  const body = form.get("Body") ?? "";
  if (!inboundSid || !from || !to) return twiml("This message was incomplete.");
  if (to !== channel.phoneNumber) return twiml("This number is not configured.");
  if (!E164.test(from)) return twiml();

  if (!(await claimSmsEvent(channel.id, inboundSid))) return twiml();

  const linkMatch = body.trim().match(/^link(?:\s+(\S+))?\s*$/i);
  if (linkMatch) {
    const code = linkMatch[1] ?? "";
    if (!code) return twiml('Send "link <code>" using the code from Agent Studio.');
    const linked = await linkSmsPhoneWithCode(channel.workspaceId, code, from);
    if (!linked.ok) {
      return twiml(
        linked.reason === "phone-in-use"
          ? "This phone is already linked to another workspace member."
          : "That link code is invalid or expired. Create a new code in Agent Studio.",
      );
    }
    try {
      await writeAuditEvent({
        workspaceId: channel.workspaceId,
        actorUserId: linked.userId,
        source: "dashboard_event",
        kind: "sms_identity.linked",
        targetType: "member",
        targetId: linked.userId,
        agentName: null,
        payload: { smsChannelId: channel.id },
      });
    } catch {
      // The phone is already linked; audit provenance is best-effort.
    }
    return twiml("Phone linked. Send help to see the available agents.");
  }

  const member = await getSmsMemberByPhone(channel.workspaceId, from);
  if (!member) {
    return twiml(
      'This phone is not linked. Sign in to Agent Studio, open Text messages, and choose "Link this phone."',
    );
  }

  const scoped = await listAgentsForSmsChannel(channel);
  if (scoped.length === 0) {
    return twiml("No agents are connected to this number yet.");
  }
  const normalized = body.trim().toLowerCase();
  if (["help", "agents", "list"].includes(normalized)) {
    return twiml(agentMenu(scoped));
  }

  let routed = matchExplicitAgent(scoped, body);
  if (!routed && scoped.length === 1) {
    routed = { agentName: scoped[0].name, input: body };
  }
  if (!routed) {
    const apiKey = await getRouterKey(channel.workspaceId);
    if (apiKey) {
      const classified = await classifyMessage({
        apiKey,
        agents: scoped,
        message: body,
      });
      if (classified.agentName) routed = classified;
    }
  }
  if (!routed) return twiml(agentMenu(scoped));

  const result = await dispatchSmsToAgent({
    channel,
    userId: member.userId,
    agentName: routed.agentName,
    inboundSid,
    from,
    to,
    input: routed.input,
  });
  return result.ok
    ? twiml(`${result.agentName} is working on it. I'll text the result shortly.`)
    : twiml(result.message);
}
