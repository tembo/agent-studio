import "server-only";

import { writeAuditEvent } from "@/lib/audit-db";
import { createRun } from "@/lib/runs-api";
import {
  countRecentSmsDispatches,
  recordSmsDelivery,
  type SmsChannel,
} from "@/lib/sms-channel";
import { resolveAgentForDispatch } from "@/lib/workspace-agents";

const RATE_LIMIT_PER_MINUTE = 10;

export type SmsDispatchResult =
  | { ok: true; runId: string; agentName: string }
  | { ok: false; message: string };

export async function dispatchSmsToAgent(args: {
  channel: SmsChannel;
  inboundSid: string;
  from: string;
  to: string;
  body: string;
}): Promise<SmsDispatchResult> {
  const { channel, inboundSid, from, to } = args;
  const body = args.body.trim();
  if (!body) return { ok: false, message: "Send a message with some text." };

  const recent = await countRecentSmsDispatches(channel.id, from, 60);
  if (recent >= RATE_LIMIT_PER_MINUTE) {
    return {
      ok: false,
      message: "Too many messages at once. Wait a minute, then try again.",
    };
  }

  const dispatch = await resolveAgentForDispatch(
    channel.workspaceId,
    channel.agentName,
  );
  if (!dispatch.ok) {
    return {
      ok: false,
      message: `The configured agent could not be loaded: ${dispatch.error.message}`,
    };
  }
  const agent = dispatch.resolved;

  try {
    const { runId } = await createRun({
      workspaceId: channel.workspaceId,
      userId: channel.defaultOwnerUserId,
      agentName: agent.agentName,
      agentPath: agent.agentPath,
      model: agent.model,
      userMessage: body,
      framework: agent.framework,
      specContent: agent.specContent,
      specFormat: agent.specFormat,
      toolsModuleContent: agent.toolsModuleContent,
      skillsContent: agent.skillsContent,
      trigger: "event",
      agentVersionId: agent.versionId,
      agentVersionLabel: agent.versionLabel,
      delivery: agent.delivery,
    });
    await recordSmsDelivery({
      runId,
      smsChannelId: channel.id,
      inboundSid,
      recipientNumber: from,
      senderNumber: to,
    });
    try {
      await writeAuditEvent({
        workspaceId: channel.workspaceId,
        actorUserId: channel.defaultOwnerUserId,
        source: "dashboard_event",
        kind: "sms.dispatch",
        targetType: "run",
        targetId: runId,
        agentName: agent.agentName,
        payload: {
          smsChannelId: channel.id,
          inboundSid,
          from,
          to,
        },
      });
    } catch {
      // The run is already queued; audit provenance is best-effort.
    }
    return { ok: true, runId, agentName: agent.agentName };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Failed to start the run.",
    };
  }
}
