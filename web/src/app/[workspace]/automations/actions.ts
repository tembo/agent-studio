"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { writeAuditEvent } from "@/lib/audit-db";
import {
  authorizeWorkspace,
  DENIED_MESSAGE,
} from "@/lib/auth-server";
import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  updateAutomation,
} from "@/lib/automations-api";
import { validateCron } from "@/lib/cron";
import { userIsMember } from "@/lib/workspace";
import { getAgentByName } from "@/lib/workspace-agents";

export type AutomationFormState = {
  error?: string;
  fieldErrors?: Partial<Record<"name" | "agent" | "cron", string>>;
};

const INVALID_OWNER_MESSAGE = "Choose a workspace member to run this automation.";

// Both create and update share these field-level checks.
type ParsedForm = {
  workspaceSlug: string;
  name: string;
  agentName: string;
  cron: string;
  timezone: string;
  inputMessage: string;
  enabled: boolean;
  /** Workspace member whose credentials each scheduled run uses. */
  ownerUserId: string;
  /** Run the live draft instead of the agent's stable version. */
  useDraft: boolean;
};

function parseForm(formData: FormData): ParsedForm {
  return {
    workspaceSlug: String(formData.get("workspace") ?? ""),
    name: String(formData.get("name") ?? "").trim(),
    agentName: String(formData.get("agent") ?? "").trim(),
    cron: String(formData.get("cron") ?? "").trim(),
    timezone: String(formData.get("timezone") ?? "UTC"),
    inputMessage: String(formData.get("input_message") ?? ""),
    enabled: formData.get("enabled") === "on",
    ownerUserId: String(formData.get("owner_user_id") ?? "").trim(),
    useDraft: formData.get("use_draft") === "on",
  };
}

async function validate(
  workspaceId: string,
  parsed: ParsedForm,
): Promise<AutomationFormState | null> {
  const fieldErrors: AutomationFormState["fieldErrors"] = {};
  if (!parsed.name) fieldErrors.name = "Name is required.";
  if (!parsed.agentName) fieldErrors.agent = "Pick an agent.";
  if (parsed.agentName) {
    const found = await getAgentByName(workspaceId, parsed.agentName);
    if (!found) fieldErrors.agent = "That agent isn't in this workspace.";
  }
  const cronCheck = validateCron(parsed.cron, parsed.timezone);
  if (!cronCheck.ok) fieldErrors.cron = cronCheck.error;
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };
  return null;
}

async function validateOwnerUserId(
  workspaceId: string,
  ownerUserId: string,
): Promise<AutomationFormState | null> {
  if (await userIsMember(workspaceId, ownerUserId)) return null;
  return { error: INVALID_OWNER_MESSAGE };
}

export async function createAutomationAction(
  _prev: AutomationFormState,
  formData: FormData,
): Promise<AutomationFormState> {
  const parsed = parseForm(formData);
  const auth = await authorizeWorkspace(parsed.workspaceSlug, "operator");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }
  const { workspace, userId } = auth;

  const invalid = await validate(workspace.id, parsed);
  if (invalid) return invalid;

  // Owner defaults to the creator when the form leaves the picker
  // blank. Scheduled runs use this user's per-user credentials, so
  // never trust the posted picker value without a membership check.
  const ownerUserId = parsed.ownerUserId || userId;
  const invalidOwner = await validateOwnerUserId(workspace.id, ownerUserId);
  if (invalidOwner) return invalidOwner;

  const created = await createAutomation({
    workspaceId: workspace.id,
    name: parsed.name,
    agentName: parsed.agentName,
    cron: parsed.cron,
    timezone: parsed.timezone,
    inputMessage: parsed.inputMessage,
    enabled: parsed.enabled,
    userId,
    ownerUserId,
    useDraft: parsed.useDraft,
  });

  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "human_action",
    kind: "automation.created",
    targetType: "automation",
    targetId: created.id,
    agentName: parsed.agentName,
    payload: {
      name: parsed.name,
      cron: parsed.cron,
      timezone: parsed.timezone,
      enabled: parsed.enabled,
      ownerUserId,
    },
  });

  revalidatePath(`/${parsed.workspaceSlug}/automations`);
  revalidatePath(`/${parsed.workspaceSlug}/agents/${encodeURIComponent(parsed.agentName)}`);
  redirect(`/${parsed.workspaceSlug}/automations`);
}

export async function updateAutomationAction(
  _prev: AutomationFormState,
  formData: FormData,
): Promise<AutomationFormState> {
  const id = String(formData.get("id") ?? "");
  const existing = await getAutomation(id);
  if (!existing) notFound();

  const parsed = parseForm(formData);
  const auth = await authorizeWorkspace(parsed.workspaceSlug, "operator");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }
  const { workspace, userId } = auth;
  if (workspace.id !== existing.workspaceId) notFound();

  // Editing from another browser must never move the schedule.
  parsed.timezone = existing.timezone;
  const invalid = await validate(workspace.id, parsed);
  if (invalid) return invalid;

  const ownerUserId = parsed.ownerUserId || existing.ownerUserId;
  const invalidOwner = await validateOwnerUserId(workspace.id, ownerUserId);
  if (invalidOwner) return invalidOwner;

  await updateAutomation({
    id,
    name: parsed.name,
    agentName: parsed.agentName,
    cron: parsed.cron,
    inputMessage: parsed.inputMessage,
    enabled: parsed.enabled,
    // Preserve the existing owner when the form omits the picker
    // (e.g. an older client). The form's hidden default value should
    // always send the current owner so the edit doesn't accidentally
    // re-assign.
    ownerUserId,
    useDraft: parsed.useDraft,
  });

  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "human_action",
    kind: "automation.updated",
    targetType: "automation",
    targetId: id,
    agentName: parsed.agentName,
    payload: {
      name: parsed.name,
      cron: parsed.cron,
      timezone: parsed.timezone,
      enabled: parsed.enabled,
      ownerUserId,
      agentChanged: existing.agentName !== parsed.agentName,
      previousAgent: existing.agentName,
    },
  });

  revalidatePath(`/${parsed.workspaceSlug}/automations`);
  revalidatePath(`/${parsed.workspaceSlug}/agents/${encodeURIComponent(parsed.agentName)}`);
  if (existing.agentName !== parsed.agentName) {
    // The owning agent changed — refresh the old agent's page too so
    // its "Automations" section drops this row.
    revalidatePath(`/${parsed.workspaceSlug}/agents/${encodeURIComponent(existing.agentName)}`);
  }
  redirect(`/${parsed.workspaceSlug}/automations`);
}

export type DeleteAutomationFormState = { error?: string };
const DELETE_EMPTY: DeleteAutomationFormState = {};

export async function deleteAutomationAction(
  _prev: DeleteAutomationFormState,
  formData: FormData,
): Promise<DeleteAutomationFormState> {
  const id = String(formData.get("id") ?? "");
  const workspaceSlug = String(formData.get("workspace") ?? "");
  const existing = await getAutomation(id);
  if (!existing) notFound();

  const auth = await authorizeWorkspace(workspaceSlug, "operator");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }
  const { workspace, userId } = auth;
  if (workspace.id !== existing.workspaceId) notFound();

  await deleteAutomation(id);
  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "human_action",
    kind: "automation.deleted",
    targetType: "automation",
    targetId: id,
    agentName: existing.agentName,
    payload: { name: existing.name, cron: existing.cron },
  });
  revalidatePath(`/${workspaceSlug}/automations`);
  revalidatePath(`/${workspaceSlug}/agents/${encodeURIComponent(existing.agentName)}`);
  return DELETE_EMPTY;
}

// Quick enable/disable toggle without going through the full edit
// form. Reuses the update path; the form on the list page renders a
// single hidden enabled field + an immediate submit on change.
export async function toggleAutomationAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const enabled = formData.get("enabled") === "true";
  const workspaceSlug = String(formData.get("workspace") ?? "");

  const existing = await getAutomation(id);
  if (!existing) notFound();

  // toggleAutomationAction has no return state (void), so a denied
  // role here can't surface an error message in the UI — we silently
  // 404 the way we did for non-membership. The toggle button should
  // be hidden in the UI for viewers anyway (US-0.4-89).
  const auth = await authorizeWorkspace(workspaceSlug, "operator");
  if (!auth.ok) notFound();
  const { workspace, userId } = auth;
  if (workspace.id !== existing.workspaceId) notFound();
  if (await validateOwnerUserId(workspace.id, existing.ownerUserId)) notFound();

  await updateAutomation({
    id,
    name: existing.name,
    agentName: existing.agentName,
    cron: existing.cron,
    inputMessage: existing.inputMessage,
    enabled,
    ownerUserId: existing.ownerUserId,
  });
  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "human_action",
    kind: enabled ? "automation.enabled" : "automation.disabled",
    targetType: "automation",
    targetId: id,
    agentName: existing.agentName,
    payload: { name: existing.name },
  });
  revalidatePath(`/${workspaceSlug}/automations`);
  revalidatePath(`/${workspaceSlug}/agents/${encodeURIComponent(existing.agentName)}`);
}
