"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";

import { writeAuditEvent } from "@/lib/audit-db";
import { listAgentsByLabels } from "@/lib/agent-scope";
import { authorizeWorkspace, DENIED_MESSAGE } from "@/lib/auth-server";
import {
  createSmsChannel,
  deleteSmsChannel,
  getSmsChannel,
  updateSmsChannel,
} from "@/lib/sms-channel";
import { listWorkspaceMembers } from "@/lib/workspace";

export type SmsChannelFormState = { error?: string; message?: string };

const ACCOUNT_SID = /^AC[0-9a-f]{32}$/i;
const E164 = /^\+[1-9]\d{7,14}$/;

function parseLabels(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((label) => label.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

export async function saveSmsChannelAction(
  _previous: SmsChannelFormState,
  formData: FormData,
): Promise<SmsChannelFormState> {
  const slug = String(formData.get("workspace") ?? "");
  const id = String(formData.get("id") ?? "");
  const accountSid = String(formData.get("account_sid") ?? "").trim();
  const authToken = String(formData.get("auth_token") ?? "").trim();
  const phoneNumber = String(formData.get("phone_number") ?? "").trim();
  const allowedNumbers = Array.from(
    new Set(
      String(formData.get("allowed_numbers") ?? "")
        .split(",")
        .map((number) => number.trim())
        .filter(Boolean),
    ),
  );
  const agentLabels = parseLabels(String(formData.get("agent_labels") ?? ""));
  const defaultOwnerUserId = String(formData.get("default_owner") ?? "").trim();
  const enabled = formData.get("enabled") === "on";

  if (!ACCOUNT_SID.test(accountSid)) {
    return { error: "Enter a Twilio Account SID beginning with AC." };
  }
  if (!E164.test(phoneNumber)) {
    return { error: "Enter the Twilio number in E.164 form, such as +14155550123." };
  }
  if (allowedNumbers.length === 0 || allowedNumbers.some((number) => !E164.test(number))) {
    return { error: "Enter at least one allowed sender in E.164 form." };
  }
  if (agentLabels.length === 0) {
    return { error: "Enter at least one agent label." };
  }
  if (!defaultOwnerUserId) return { error: "Choose the member these runs act as." };

  const auth = await authorizeWorkspace(slug, "workspace_admin");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }

  const current = await getSmsChannel(auth.workspace.id);
  if (!current && !authToken) return { error: "Enter the Twilio Auth Token." };
  if (id && current?.id !== id) return { error: "Text-message configuration not found." };

  const members = await listWorkspaceMembers(auth.workspace.id);
  if (!members.some((member) => member.userId === defaultOwnerUserId)) {
    return { error: "The selected default owner is not a workspace member." };
  }
  const scopedAgents = await listAgentsByLabels(auth.workspace.id, agentLabels);
  if (scopedAgents.length === 0) {
    return { error: "No valid agents have any of those labels." };
  }

  try {
    if (current) {
      await updateSmsChannel(auth.workspace.id, current.id, {
        accountSid,
        ...(authToken ? { authToken } : {}),
        phoneNumber,
        allowedNumbers,
        agentLabels,
        defaultOwnerUserId,
        enabled,
      });
    } else {
      await createSmsChannel({
        workspaceId: auth.workspace.id,
        accountSid,
        authToken,
        phoneNumber,
        allowedNumbers,
        agentLabels,
        defaultOwnerUserId,
        createdBy: auth.userId,
      });
    }
  } catch {
    return { error: "Couldn't save the text-message channel." };
  }

  const saved = await getSmsChannel(auth.workspace.id);
  await writeAuditEvent({
    workspaceId: auth.workspace.id,
    actorUserId: auth.userId,
    source: "human_action",
    kind: current ? "sms_channel.updated" : "sms_channel.created",
    targetType: "sms_channel",
    targetId: saved?.id ?? null,
    agentName: null,
    payload: {
      phoneNumber,
      agentLabels,
      enabled: current ? enabled : true,
      authTokenRotated: Boolean(authToken),
    },
  });
  revalidatePath(`/${slug}/text-messages`);
  return { message: current ? "Text-message channel updated." : "Text-message channel created." };
}

export async function deleteSmsChannelAction(formData: FormData): Promise<void> {
  const slug = String(formData.get("workspace") ?? "");
  const id = String(formData.get("id") ?? "");
  const auth = await authorizeWorkspace(slug, "workspace_admin");
  if (!auth.ok) return;
  const channel = await getSmsChannel(auth.workspace.id);
  if (!channel || channel.id !== id) return;
  await deleteSmsChannel(auth.workspace.id, channel.id);
  await writeAuditEvent({
    workspaceId: auth.workspace.id,
    actorUserId: auth.userId,
    source: "human_action",
    kind: "sms_channel.deleted",
    targetType: "sms_channel",
    targetId: channel.id,
    agentName: null,
    payload: { phoneNumber: channel.phoneNumber },
  });
  revalidatePath(`/${slug}/text-messages`);
}
