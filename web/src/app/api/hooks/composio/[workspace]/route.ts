import { NextResponse, type NextRequest } from "next/server";

import {
  agentResolutionFailure,
  automationServiceConfigurationFailure,
  recordAutomationFailure,
  recordAutomationSuccess,
  runApiFailure,
  runApiRequestFailure,
} from "@/lib/automation-events";
import { verifyTriggerWebhook } from "@/lib/composio";
import {
  getTriggerByComposioId,
  type WorkspaceTrigger,
} from "@/lib/triggers-db";
import { resolveAgentForDispatch } from "@/lib/workspace-agents";
import {
  getWorkspaceBySlug,
  getWorkspaceSecretPlaintext,
  getWorkspaceSecretPreview,
} from "@/lib/workspace";

// Composio webhook receiver. One endpoint per workspace, scoped by
// slug — that way each workspace's Composio account uses its own
// signing secret (workspace_secret kind=composio_webhook_secret), no
// shared TAS-instance-wide key required.
//
// Auth here is the HMAC signature, not a TAS session — Composio
// doesn't have one. The signature is computed over the raw request
// body, so we must read text() before any JSON parsing and pass that
// untouched into verifyTriggerWebhook.
//
// On a verified payload we look up workspace_trigger by the Composio
// trigger_id, then enqueue a run with trigger='event' through the
// same /internal/runs surface that scheduled + manual runs use. The
// agent receives the event as user_message JSON.

export const dynamic = "force-dynamic";

type RouteParams = Promise<{ workspace: string }>;

export async function POST(
  request: NextRequest,
  { params }: { params: RouteParams },
): Promise<NextResponse> {
  const { workspace: slug } = await params;
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) {
    return NextResponse.json({ error: "unknown workspace" }, { status: 404 });
  }

  const webhookId = request.headers.get("webhook-id");
  const webhookTimestamp = request.headers.get("webhook-timestamp");
  const webhookSignature = request.headers.get("webhook-signature");
  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    return NextResponse.json(
      { error: "missing webhook-* headers" },
      { status: 400 },
    );
  }

  // Read raw body BEFORE any parsing — the HMAC is over these bytes.
  const rawBody = await request.text();

  const secretPreview = await getWorkspaceSecretPreview(
    workspace.id,
    "composio_webhook_secret",
  );
  const apiKeyPreview = await getWorkspaceSecretPreview(
    workspace.id,
    "composio_api_key",
  );
  if (!secretPreview || !apiKeyPreview) {
    return NextResponse.json(
      { error: "workspace not configured for Composio webhooks" },
      { status: 412 },
    );
  }
  const secret = await getWorkspaceSecretPlaintext(
    workspace.id,
    "composio_webhook_secret",
  );
  const apiKey = await getWorkspaceSecretPlaintext(
    workspace.id,
    "composio_api_key",
  );

  let verified;
  try {
    verified = await verifyTriggerWebhook({
      apiKey,
      secret,
      rawBody,
      webhookId,
      webhookTimestamp,
      webhookSignature,
    });
  } catch (e) {
    const err = e as Error;
    console.warn(`[composio-webhook] signature verify failed: ${err.message}`);
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const trigger = await getTriggerByComposioId(verified.triggerId);
  if (!trigger || trigger.workspaceId !== workspace.id) {
    // Either an old trigger we deleted locally, or a different
    // workspace's webhook arriving at the wrong URL. Acknowledge with
    // 200 so Composio stops retrying, but record nothing.
    console.warn(
      `[composio-webhook] no local trigger for ${verified.triggerId} (workspace=${workspace.slug})`,
    );
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }
  if (!trigger.enabled) {
    return NextResponse.json({ status: "disabled" }, { status: 200 });
  }

  // Resolve the agent — event-driven runs use the current stable version
  // (same default as the scheduler when an automation hasn't opted into draft).
  const dispatch = await resolveAgentForDispatch(
    workspace.id,
    trigger.agentName,
  );
  if (!dispatch.ok) {
    await recordAutomationFailure({
      kind: "trigger",
      id: trigger.id,
      failure: agentResolutionFailure(dispatch.error),
    });
    return NextResponse.json(
      { status: `agent-${dispatch.error.kind}` },
      { status: 200 },
    );
  }
  const r = dispatch.resolved;

  // The agent's user_message for an event-driven run is the
  // structured event itself. Tembo writes agents to expect this shape:
  // a JSON object with trigger_type + payload at the top level. Anything
  // an agent doesn't know about it can ignore.
  const userMessage = JSON.stringify({
    trigger_type: verified.triggerSlug,
    trigger_id: verified.triggerId,
    toolkit: verified.toolkitSlug,
    payload: verified.payload,
  });

  const apiUrl = process.env.API_INTERNAL_URL ?? "http://localhost:8080";
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) {
    await recordAutomationFailure({
      kind: "trigger",
      id: trigger.id,
      failure: automationServiceConfigurationFailure(),
    });
    return NextResponse.json({ status: "misconfigured" }, { status: 500 });
  }

  let runId: string | null = null;
  try {
    const res = await fetch(`${apiUrl}/internal/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      body: JSON.stringify({
        workspace_id: workspace.id,
        // Event-driven runs act as the trigger's owner — same
        // pattern as automation.owner_user_id. The owner's
        // connections are what the Composio runtime resolves.
        user_id: trigger.userId,
        agent_name: r.agentName,
        agent_path: r.agentPath,
        model: r.model,
        user_message: userMessage,
        framework: r.framework,
        spec_content: r.specContent,
        spec_format: r.specFormat,
        tools_module_content: r.toolsModuleContent,
        skills_content: r.skillsContent,
        trigger: "event",
        agent_version_id: r.versionId,
        agent_version_label: r.versionLabel,
        output_delivery: r.delivery,
      }),
    });
    if (!res.ok) {
      await recordAutomationFailure({
        kind: "trigger",
        id: trigger.id,
        failure: runApiFailure(res.status),
      });
      return NextResponse.json(
        { status: "run-api-error", upstream: res.status },
        { status: 200 },
      );
    }
    const j = (await res.json()) as { run_id?: string };
    runId = j.run_id ?? null;
  } catch (e) {
    await recordAutomationFailure({
      kind: "trigger",
      id: trigger.id,
      failure: runApiRequestFailure(e),
    });
    return NextResponse.json({ status: "run-api-throw" }, { status: 200 });
  }

  await recordAutomationSuccess({
    kind: "trigger",
    id: trigger.id,
    runId,
  });
  // Surface the run id for Composio's webhook log — useful when
  // tracing "this event produced that run" in their dashboard.
  return NextResponse.json({ status: "ok", run_id: runId }, { status: 200 });
}

// Re-export the type so future helpers can import it from here too.
export type { WorkspaceTrigger };
