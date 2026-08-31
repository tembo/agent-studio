import { NextResponse, type NextRequest } from "next/server";

import {
  agentResolutionFailure,
  recordAutomationFailure,
  recordAutomationSuccess,
  runApiRequestFailure,
} from "@/lib/automation-events";
import { createRun } from "@/lib/runs-api";
import {
  countRecentEventRuns,
  getWebhookForInbound,
  webhookSvixMatches,
  webhookTokenMatches,
} from "@/lib/webhooks-db";
import { resolveAgentForDispatch } from "@/lib/workspace-agents";

// External webhook receiver. An outside system (Clay first) POSTs JSON here to
// fire an agent run:
//
//   POST /api/hooks/webhook/<id>
//   Authorization: Bearer <token>        (bearer mode — Clay)
//   { ...arbitrary JSON the agent interprets... }
//
// Auth is per-webhook, not a TAS session (the caller has no session). The row
// id in the URL is the public selector. Two modes: a bearer token
// (constant-time compared in webhookTokenMatches), or — for senders that can't
// set a custom header, notably Clerk — Svix request signing, verified against
// the webhook's stored signing secret (webhookSvixMatches) using the
// svix-id/svix-timestamp/svix-signature headers.
//
// Fire-and-forget: we queue the run via /internal/runs (trigger='event') and
// ack 202 immediately. The agent receives the request body as its input; its
// output lands in /runs and any write-back is done by the agent's own tools.

export const dynamic = "force-dynamic";

// Generous safety valve — blunts a misconfigured/looping sender without
// dropping Clay's legitimate batched bursts.
const MAX_EVENT_RUNS_PER_MIN = 120;

type RouteParams = Promise<{ webhookId: string }>;

function bearer(request: NextRequest): string | null {
  const h = request.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: RouteParams },
): Promise<NextResponse> {
  const { webhookId } = await params;

  // Read the raw body before anything else, then try to parse it as JSON. A
  // non-JSON body is passed through as a raw string — the agent decides.
  const rawBody = await request.text();

  const webhook = await getWebhookForInbound(webhookId);
  if (!webhook) {
    return NextResponse.json({ error: "unknown webhook" }, { status: 404 });
  }
  if (!webhook.enabled) {
    return NextResponse.json({ error: "webhook disabled" }, { status: 403 });
  }

  // Signed webhooks (Clerk) verify the Svix signature; everything else uses the
  // bearer token. The signing secret's presence picks the mode.
  if (webhook.signingSecretCiphertext) {
    const ok = webhookSvixMatches(webhook, {
      rawBody,
      svixId: request.headers.get("svix-id"),
      svixTimestamp: request.headers.get("svix-timestamp"),
      svixSignature: request.headers.get("svix-signature"),
    });
    if (!ok) {
      return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }
  } else {
    const presented = bearer(request);
    if (!presented || !webhookTokenMatches(webhook, presented)) {
      return NextResponse.json({ error: "invalid token" }, { status: 401 });
    }
  }

  const recent = await countRecentEventRuns(
    webhook.workspaceId,
    webhook.agentName,
    60,
  );
  if (recent >= MAX_EVENT_RUNS_PER_MIN) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }

  const dispatch = await resolveAgentForDispatch(
    webhook.workspaceId,
    webhook.agentName,
  );
  if (!dispatch.ok) {
    await recordAutomationFailure({
      kind: "webhook",
      id: webhook.id,
      failure: agentResolutionFailure(dispatch.error),
    });
    return NextResponse.json(
      { error: `agent ${dispatch.error.kind}: ${dispatch.error.message}` },
      { status: 502 },
    );
  }
  const r = dispatch.resolved;

  // The agent's input is the event envelope. Clay may send a single row or a
  // batch with arbitrary field names — we pass the body through untouched as
  // `payload` and let the agent's instructions + tools_module map the fields.
  let payload: unknown = rawBody;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    // leave payload as the raw string
  }
  const userMessage = JSON.stringify({
    trigger_type: "webhook",
    webhook_id: webhook.id,
    webhook: webhook.name,
    payload,
  });

  let runId: string;
  try {
    const res = await createRun({
      workspaceId: webhook.workspaceId,
      userId: webhook.ownerUserId,
      agentName: r.agentName,
      agentPath: r.agentPath,
      model: r.model,
      userMessage,
      framework: r.framework,
      specContent: r.specContent,
      specFormat: r.specFormat,
      toolsModuleContent: r.toolsModuleContent,
      skillsContent: r.skillsContent,
      trigger: "event",
      agentVersionId: r.versionId,
      agentVersionLabel: r.versionLabel,
      delivery: r.delivery,
    });
    runId = res.runId;
  } catch (e) {
    await recordAutomationFailure({
      kind: "webhook",
      id: webhook.id,
      failure: runApiRequestFailure(e),
    });
    return NextResponse.json({ error: "could not queue run" }, { status: 502 });
  }

  await recordAutomationSuccess({
    kind: "webhook",
    id: webhook.id,
    runId,
  });
  return NextResponse.json({ status: "queued", run_id: runId }, { status: 202 });
}
