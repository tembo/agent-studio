import { NextResponse, type NextRequest } from "next/server";

import { getPublicOrigin } from "@/lib/config";
import { dispatchSmsToAgent } from "@/lib/sms-dispatch";
import {
  claimSmsEvent,
  getSmsAuthToken,
  getSmsChannelById,
} from "@/lib/sms-channel";
import { verifyTwilioRequest } from "@/lib/twilio-verify";

export const dynamic = "force-dynamic";

type RouteParams = Promise<{ channelId: string }>;

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
  if (!channel.allowedNumbers.includes(from)) return twiml();

  if (!(await claimSmsEvent(channel.id, inboundSid))) return twiml();

  const result = await dispatchSmsToAgent({
    channel,
    inboundSid,
    from,
    to,
    body,
  });
  return result.ok
    ? twiml(`${result.agentName} is working on it. I'll text the result shortly.`)
    : twiml(result.message);
}
