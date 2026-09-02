"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import YAML from "yaml";

import { writeAuditEvent } from "@/lib/audit-db";
import {
  authorizeWorkspace,
  DENIED_MESSAGE,
} from "@/lib/auth-server";
import {
  createTrigger,
  deleteTrigger as deleteTriggerRemote,
  setTriggerEnabledRemote,
} from "@/lib/composio";
import { getComposioConnectionById } from "@/lib/composio-connections";
import {
  findMissingConnections,
  missingConnectionsMessage,
} from "@/lib/connection-checks";
import { dryRunUnavailableReason } from "@/lib/dry-run";
import { createRun } from "@/lib/runs-api";
import {
  getAgentOwner,
  getStableVersion,
  promoteToStable,
  setAgentOwner,
} from "@/lib/agent-versions";
import { summarizeSpecDiff } from "@/lib/agent-version-summary";
import { isAgentLocked, setAgentLock } from "@/lib/agent-lock";
import {
  upsertAgentLearning,
  type LearningCadence,
} from "@/lib/agent-learning-api";
import { diffLines, type TextDiff } from "@/lib/text-diff";
import {
  deleteTriggerLocal,
  getTriggerById,
  saveTrigger,
  setTriggerEnabled,
} from "@/lib/triggers-db";
import {
  deleteAgent,
  forkAgent,
  getAgentByName,
  resolveAgentForDispatch,
  type DeleteAgentError,
  type ForkAgentResult,
} from "@/lib/workspace-agents";
import { getServerSession } from "@/lib/session";
import {
  getWorkspaceRole,
  getWorkspaceSecretPlaintext,
  getWorkspaceSecretPreview,
} from "@/lib/workspace";

export type DeleteAgentFormState = {
  error?: string;
};

const ERROR_MESSAGES: Record<DeleteAgentError, string> = {
  "no-repo": "Connect a Git repository before deleting an agent.",
  "not-found": "Agent file no longer exists in the repo.",
  "invalid-token":
    "The workspace's stored GitHub token is no longer valid. Reconnect the repo in Settings.",
  "path-exists":
    "Couldn't delete — GitHub reported a conflict. Try again.",
  "branch-protected":
    "The default branch is protected. Ask an admin to relax protections, or use v0.2's chat-to-PR flow.",
  "sha-mismatch":
    "The file changed since this page loaded. Refresh and try again.",
  "rate-limited":
    "GitHub rate-limited that request. Try again in a few minutes.",
  network: "Couldn't reach GitHub. Try again in a moment.",
};

export async function deleteAgentAction(
  _prev: DeleteAgentFormState,
  formData: FormData,
): Promise<DeleteAgentFormState> {
  const slug = String(formData.get("workspace") ?? "");
  const agentName = String(formData.get("agent") ?? "");

  const auth = await authorizeWorkspace(slug, "operator");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }
  const { workspace, userId } = auth;

  const result = await deleteAgent(workspace.id, userId, agentName);
  if (!result.ok) {
    return { error: ERROR_MESSAGES[result.error] };
  }
  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "human_action",
    kind: "agent.deleted",
    targetType: "agent",
    targetId: agentName,
    agentName,
    payload: {},
  });
  revalidatePath(`/${slug}`);
  revalidatePath(`/${slug}/settings`);
  // ?deleted=<name> gives the agents grid two affordances: render a
  // "Deleted {name}" confirmation banner, and defensively filter
  // the named agent out of the listing in case the GitHub fetch
  // cache hasn't propagated the deletion yet (60s TTL on listAgents
  // reads — fine for normal usage, jarring for a just-deleted row).
  redirect(`/${slug}?deleted=${encodeURIComponent(agentName)}`);
}

export type RunNowFormState = {
  error?: string;
};

export async function runNowAction(
  _prev: RunNowFormState,
  formData: FormData,
): Promise<RunNowFormState> {
  const slug = String(formData.get("workspace") ?? "");
  const agentName = String(formData.get("agent") ?? "");
  // Optional user input. Empty preserves the prior behavior (a "no
  // input" run that just exercises the agent's instructions).
  const userMessage = String(formData.get("user_message") ?? "");
  const runAsRaw = String(formData.get("run_as") ?? "").trim();
  // The manual-run dialog submits its explicit selection. Missing or invalid
  // values stay on stable as the defensive server-side fallback.
  const preferDraft = String(formData.get("run_version") ?? "") === "draft";
  const dryRun = String(formData.get("dry_run") ?? "") === "1";

  const auth = await authorizeWorkspace(slug, "operator");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }
  const { workspace, userId, role } = auth;

  // Admins may run AS another member so the run executes against that
  // member's connections (Composio / Native MCP). Everyone else runs as
  // themselves.
  let actingUserId = userId;
  if (runAsRaw && runAsRaw !== userId) {
    if (role !== "workspace_admin") {
      return { error: "Only workspace admins can run as another member." };
    }
    const targetRole = await getWorkspaceRole(workspace.id, runAsRaw);
    if (!targetRole) {
      return { error: "That user isn't a member of this workspace." };
    }
    actingUserId = runAsRaw;
  }

  // Resolve the selected spec. With no stable snapshot, dispatch naturally
  // falls back to the live draft.
  const dispatch = await resolveAgentForDispatch(workspace.id, agentName, {
    preferDraft,
  });
  if (!dispatch.ok) {
    return { error: dispatch.error.message };
  }
  const r = dispatch.resolved;
  if (dryRun) {
    const reason = dryRunUnavailableReason({
      framework: r.framework,
      delivery: r.delivery,
      connections: connectionsFromSpec(r.specContent, r.specFormat),
    });
    if (reason) return { error: reason };
  }

  // Pre-flight: don't start a run the acting user can't complete. Without an
  // active connection for each declared service the wrapper fails mid-run with
  // a traceback — block it here with an actionable message instead.
  const missing = await findMissingConnections(
    workspace.id,
    actingUserId,
    r.connections,
  );
  if (missing.length > 0) {
    return {
      error: missingConnectionsMessage(missing, actingUserId === userId),
    };
  }

  let runId: string;
  try {
    const res = await createRun({
      workspaceId: workspace.id,
      userId: actingUserId,
      agentName: r.agentName,
      agentPath: r.agentPath,
      model: r.model,
      framework: r.framework,
      specContent: r.specContent,
      specFormat: r.specFormat,
      toolsModuleContent: r.toolsModuleContent,
      skillsContent: r.skillsContent,
      userMessage,
      agentVersionId: r.versionId,
      agentVersionLabel: r.versionLabel,
      delivery: r.delivery,
      isDryRun: dryRun,
    });
    runId = res.runId;
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Couldn't queue the run.",
    };
  }

  revalidatePath(`/${slug}/agents/${encodeURIComponent(r.agentName)}`);
  redirect(
    `/${slug}/agents/${encodeURIComponent(r.agentName)}/runs/${encodeURIComponent(runId)}`,
  );
}

function connectionsFromSpec(content: string, format: string): unknown {
  try {
    const obj = format === "json" ? JSON.parse(content) : YAML.parse(content);
    return obj && typeof obj === "object" ? obj.connections : undefined;
  } catch {
    return undefined;
  }
}

// ────────────────────────────────────────────────────────────────────
// Lifecycle: promote the draft to a numbered Stable version, and assign
// the agent's owner.

export type PromoteFormState = {
  error?: string;
  message?: string;
};

export async function promoteAgentAction(
  _prev: PromoteFormState,
  formData: FormData,
): Promise<PromoteFormState> {
  const slug = String(formData.get("workspace") ?? "");
  const agentName = String(formData.get("agent") ?? "");

  const auth = await authorizeWorkspace(slug, "operator");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }
  const { workspace, userId, role } = auth;

  // Owner/admin gate: the owner promotes; an admin can too (the UI warns
  // them when they aren't the owner). An unowned agent can be promoted by
  // any operator (already gated above).
  const owner = await getAgentOwner(workspace.id, agentName);
  const isOwner = owner?.ownerUserId === userId;
  const isAdmin = role === "workspace_admin";
  if (owner && !isOwner && !isAdmin) {
    return {
      error:
        "Only this agent's owner or a workspace admin can promote a new stable version.",
    };
  }

  // Never promote a broken draft — the current file must parse.
  const found = await getAgentByName(workspace.id, agentName);
  if (!found || !found.agent.ok) {
    return {
      error: found
        ? "The draft file is invalid; fix it before promoting."
        : "Agent no longer exists in the connected repo.",
    };
  }
  const spec = found.agent.spec;
  const framework: "pydantic-agentspec" | "cargo-ai" =
    spec.framework === "pydantic-agentspec" ? "pydantic-agentspec" : "cargo-ai";

  const previous = await getStableVersion(workspace.id, agentName);
  if (previous && previous.specContent === found.raw) {
    return { error: "No changes since the current stable version." };
  }

  const changeSummary = await summarizeSpecDiff({
    workspaceId: workspace.id,
    agentName,
    previous: previous?.specContent ?? null,
    next: found.raw,
  });

  let versionNumber: number;
  try {
    const version = await promoteToStable({
      workspaceId: workspace.id,
      agentName,
      agentPath: found.agent.path,
      framework,
      model: spec.model ?? null,
      specContent: found.raw,
      specFormat: found.agent.format,
      changeSummary,
      createdBy: userId,
    });
    versionNumber = version.versionNumber;
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Couldn't promote the agent.",
    };
  }

  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "human_action",
    kind: "agent.version.promoted",
    targetType: "agent",
    targetId: agentName,
    agentName,
    payload: { versionNumber, promotedByOwner: isOwner },
  });
  revalidatePath(`/${slug}/agents/${encodeURIComponent(agentName)}`);
  return { message: `Promoted to Stable v${versionNumber}.` };
}

export type DraftChangesResult =
  | { ok: true; summary: string; diff: TextDiff; invalid: boolean }
  | { ok: false; error: string };

/**
 * On-demand: what's changed in the live draft vs the current stable version
 * (summary + line diff). Called from the "draft has unreleased changes"
 * banner. Returns invalid=true when the draft no longer parses (the diff is
 * still shown, but it can't be promoted until fixed).
 */
export async function summarizeDraftAction(args: {
  workspaceSlug: string;
  agentName: string;
}): Promise<DraftChangesResult> {
  const auth = await authorizeWorkspace(args.workspaceSlug, "operator");
  if (!auth.ok) {
    if (auth.reason === "denied") return { ok: false, error: DENIED_MESSAGE };
    notFound();
  }
  const { workspace } = auth;

  const stable = await getStableVersion(workspace.id, args.agentName);
  const found = await getAgentByName(workspace.id, args.agentName);
  if (!found) {
    return { ok: false, error: "Agent no longer exists in the connected repo." };
  }
  const diff = diffLines(stable?.specContent ?? "", found.raw);
  const summary = await summarizeSpecDiff({
    workspaceId: workspace.id,
    agentName: args.agentName,
    previous: stable?.specContent ?? null,
    next: found.raw,
  });
  return { ok: true, summary, diff, invalid: !found.agent.ok };
}

export type OwnerFormState = { error?: string; message?: string };

export async function setAgentOwnerAction(
  _prev: OwnerFormState,
  formData: FormData,
): Promise<OwnerFormState> {
  const slug = String(formData.get("workspace") ?? "");
  const agentName = String(formData.get("agent") ?? "");
  const ownerUserId = String(formData.get("owner_user_id") ?? "").trim();

  const auth = await authorizeWorkspace(slug, "operator");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }
  const { workspace, userId, role } = auth;

  if (!ownerUserId) return { error: "Pick a member to own this agent." };
  const targetRole = await getWorkspaceRole(workspace.id, ownerUserId);
  if (!targetRole) {
    return { error: "That user isn't a member of this workspace." };
  }

  // An admin can (re)assign; the current owner can hand it off; an unowned
  // agent can be claimed by any operator (already gated above).
  const owner = await getAgentOwner(workspace.id, agentName);
  const canAssign =
    role === "workspace_admin" || !owner || owner.ownerUserId === userId;
  if (!canAssign) {
    return {
      error: "Only the current owner or a workspace admin can reassign ownership.",
    };
  }

  await setAgentOwner(workspace.id, agentName, ownerUserId, userId);
  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "human_action",
    kind: "agent.owner.changed",
    targetType: "agent",
    targetId: agentName,
    agentName,
    payload: { ownerUserId },
  });
  revalidatePath(`/${slug}/agents/${encodeURIComponent(agentName)}`);
  return { message: "Owner updated." };
}

// ────────────────────────────────────────────────────────────────────
// Triggers (event-driven runs via Composio)
//
// Each action follows the same shape as automation actions: validate
// membership, validate inputs, call Composio + DB, revalidate the
// agent page. Composio is the source of truth for "is this trigger
// subscribed" — we keep our row in lockstep so that disconnecting
// locally always implies a remote delete attempt and vice versa.

export type TriggerFormState = {
  error?: string;
  fieldErrors?: Partial<Record<"connection" | "triggerType" | "config", string>>;
};

const TRIGGER_FORM_EMPTY: TriggerFormState = {};

// Composio's trigger slugs are SCREAMING_SNAKE_CASE (e.g.
// GMAIL_NEW_GMAIL_MESSAGE, SLACKBOT_NEW_MESSAGE). Reject obviously
// malformed input before we round-trip to their API.
const TRIGGER_SLUG_RE = /^[A-Z][A-Z0-9_]*$/;

export async function createTriggerAction(
  _prev: TriggerFormState,
  formData: FormData,
): Promise<TriggerFormState> {
  const slug = String(formData.get("workspace") ?? "");
  const agentName = String(formData.get("agent") ?? "");
  const connectionId = String(formData.get("connection_id") ?? "").trim();
  const triggerType = String(formData.get("trigger_type") ?? "")
    .trim()
    .toUpperCase();
  const configRaw = String(formData.get("trigger_config") ?? "").trim();

  const auth = await authorizeWorkspace(slug, "operator");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }
  const { workspace, userId } = auth;

  const fieldErrors: TriggerFormState["fieldErrors"] = {};
  if (!connectionId) fieldErrors.connection = "Pick a connection.";
  if (!triggerType) {
    fieldErrors.triggerType = "Enter a Composio trigger slug.";
  } else if (!TRIGGER_SLUG_RE.test(triggerType)) {
    fieldErrors.triggerType =
      "Slug must be SCREAMING_SNAKE_CASE (letters, digits, underscores).";
  }
  let parsedConfig: Record<string, unknown> = {};
  if (configRaw.length > 0) {
    try {
      const obj = JSON.parse(configRaw);
      if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
        fieldErrors.config = "Config must be a JSON object (use {} for none).";
      } else {
        parsedConfig = obj as Record<string, unknown>;
      }
    } catch {
      fieldErrors.config = "Config isn't valid JSON.";
    }
  }
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const connection = await getComposioConnectionById(workspace.id, connectionId);
  if (!connection || connection.userId !== userId) {
    return {
      fieldErrors: { connection: "Pick one of your own connections." },
    };
  }

  // Composio API key has to be present — the trigger create call
  // hits their API. The webhook signing secret check happens in the
  // webhook handler (we'd rather create the trigger and let the user
  // realize the secret is missing when an event arrives than block
  // the form here, since the secret can be added later).
  const apiKeyPreview = await getWorkspaceSecretPreview(
    workspace.id,
    "composio_api_key",
  );
  if (!apiKeyPreview) {
    return {
      error:
        "Set a Composio API key in Settings before creating event triggers.",
    };
  }
  const apiKey = await getWorkspaceSecretPlaintext(
    workspace.id,
    "composio_api_key",
  );

  let composioTriggerId: string;
  try {
    const res = await createTrigger({
      apiKey,
      workspaceId: workspace.id,
      userId,
      triggerType,
      connectedAccountId: connection.composioConnectionId,
      triggerConfig: parsedConfig,
    });
    composioTriggerId = res.triggerId;
  } catch (e) {
    const err = e as Error;
    return { error: `Composio rejected the trigger: ${err.message}` };
  }

  const saved = await saveTrigger({
    workspaceId: workspace.id,
    userId,
    agentName,
    composioTriggerId,
    toolkitSlug: connection.toolkit,
    triggerType,
    connectionId: connection.id,
    triggerConfig: parsedConfig,
    createdBy: userId,
  });

  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "human_action",
    kind: "trigger.created",
    targetType: "trigger",
    targetId: saved.id,
    agentName,
    payload: {
      triggerType,
      toolkit: connection.toolkit,
      connectionName: connection.name,
    },
  });

  revalidatePath(`/${slug}/agents/${encodeURIComponent(agentName)}`);
  return TRIGGER_FORM_EMPTY;
}

export type SimpleTriggerActionState = { error?: string };
const SIMPLE_EMPTY: SimpleTriggerActionState = {};

export async function toggleTriggerAction(
  _prev: SimpleTriggerActionState,
  formData: FormData,
): Promise<SimpleTriggerActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const id = String(formData.get("id") ?? "");
  const enabled = formData.get("enabled") === "true";

  const auth = await authorizeWorkspace(slug, "operator");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }
  const { workspace, userId } = auth;

  const trigger = await getTriggerById(workspace.id, id);
  if (!trigger) return { error: "Trigger no longer exists." };

  const apiKey = await getWorkspaceSecretPlaintext(
    workspace.id,
    "composio_api_key",
  );
  const remoteOk = await setTriggerEnabledRemote({
    apiKey,
    triggerId: trigger.composioTriggerId,
    enabled,
  });
  // Toggle locally even on remote failure so the UI reflects intent;
  // the inconsistency is logged and surfaces next time the user
  // disconnects the agent's connection (the trigger is RESTRICTed).
  if (!remoteOk) {
    console.warn(
      `[triggers] composio enable/disable failed for ${trigger.composioTriggerId}, toggling local state anyway`,
    );
  }
  await setTriggerEnabled(workspace.id, id, enabled);
  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "human_action",
    kind: enabled ? "trigger.enabled" : "trigger.disabled",
    targetType: "trigger",
    targetId: id,
    agentName: trigger.agentName,
    payload: { triggerType: trigger.triggerType, toolkit: trigger.toolkitSlug },
  });
  revalidatePath(`/${slug}/agents/${encodeURIComponent(trigger.agentName)}`);
  return SIMPLE_EMPTY;
}

export async function deleteTriggerAction(
  _prev: SimpleTriggerActionState,
  formData: FormData,
): Promise<SimpleTriggerActionState> {
  const slug = String(formData.get("workspace") ?? "");
  const id = String(formData.get("id") ?? "");

  const auth = await authorizeWorkspace(slug, "operator");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }
  const { workspace, userId } = auth;

  const trigger = await getTriggerById(workspace.id, id);
  if (!trigger) return SIMPLE_EMPTY;

  const apiKey = await getWorkspaceSecretPlaintext(
    workspace.id,
    "composio_api_key",
  );
  // Remote delete is best-effort. If it fails we still drop the local
  // row — an orphan on Composio's side is harmless (no local trigger
  // to route the inbound webhook to, so it 200s as "ignored").
  await deleteTriggerRemote({ apiKey, triggerId: trigger.composioTriggerId });
  await deleteTriggerLocal(workspace.id, id);

  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "human_action",
    kind: "trigger.deleted",
    targetType: "trigger",
    targetId: id,
    agentName: trigger.agentName,
    payload: { triggerType: trigger.triggerType, toolkit: trigger.toolkitSlug },
  });

  revalidatePath(`/${slug}/agents/${encodeURIComponent(trigger.agentName)}`);
  return SIMPLE_EMPTY;
}

// ── Learning mode (batched Tasks Inbox learning loop) ─────────────────

export type LearningFormState = { error?: string; message?: string };

export async function setAgentLearningAction(
  _prev: LearningFormState,
  formData: FormData,
): Promise<LearningFormState> {
  const slug = String(formData.get("workspace") ?? "");
  const agentName = String(formData.get("agent") ?? "");
  const enabled = formData.get("enabled") === "on";
  const cadenceRaw = String(formData.get("cadence") ?? "daily");
  const cadence: LearningCadence = cadenceRaw === "weekly" ? "weekly" : "daily";

  const auth = await authorizeWorkspace(slug, "operator");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }
  const { workspace, userId } = auth;

  // A locked agent must not capture/adapt — refuse to enable learning on it.
  if (enabled && (await isAgentLocked(workspace.id, agentName))) {
    return { error: "This agent is locked — learning is disabled." };
  }

  // Attribute the batched improvement to whoever turned learning on (their
  // identity owns the resulting CAP task — improvement.created_by is NOT NULL).
  await upsertAgentLearning({
    workspaceId: workspace.id,
    agentName,
    enabled,
    cadence,
    ownerUserId: userId,
  });
  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "human_action",
    kind: "agent.learning.changed",
    targetType: "agent",
    targetId: agentName,
    agentName,
    payload: { enabled, cadence },
  });

  // The learning control lives on the /learning tab (not /settings). Revalidate
  // the agent layout so every tab — and the control's own `enabled` prop — re-
  // reads the just-saved value instead of a stale cached one.
  revalidatePath(`/${slug}/agents/${encodeURIComponent(agentName)}`, "layout");
  return {
    message: enabled
      ? `Learning mode on (${cadence}). Corrections you make in the Inbox batch into a PR each cycle.`
      : "Learning mode off.",
  };
}

export type LockFormState = { error?: string; message?: string };

// Admin-only "Locked" toggle. When locked, the agent's in-app edit affordances
// (Chat to edit, Improve, learning capture) are removed and its Versions /
// Activity / Learning tabs are hidden — it changes only via repo PRs. The
// scheduler skips locked agents, and the edit chokepoint (requestAgentChange)
// rejects them, so hiding the UI isn't the only line of defense.
export async function setAgentLockAction(
  _prev: LockFormState,
  formData: FormData,
): Promise<LockFormState> {
  const slug = String(formData.get("workspace") ?? "");
  const agentName = String(formData.get("agent") ?? "");
  const locked = formData.get("locked") === "on";

  const auth = await authorizeWorkspace(slug, "workspace_admin");
  if (!auth.ok) {
    if (auth.reason === "denied") return { error: DENIED_MESSAGE };
    notFound();
  }
  const { workspace, userId } = auth;

  await setAgentLock(workspace.id, agentName, locked, userId);
  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "policy_change",
    kind: "agent.lock.changed",
    targetType: "agent",
    targetId: agentName,
    agentName,
    payload: { locked },
  });

  revalidatePath(`/${slug}/agents/${encodeURIComponent(agentName)}`, "layout");
  return {
    message: locked
      ? "Agent locked. Users can't edit it and its history is hidden; change it via repo PRs."
      : "Agent unlocked.",
  };
}

const FORK_ERROR_MESSAGE: Partial<
  Record<Extract<ForkAgentResult, { ok: false }>["error"], string>
> = {
  "no-repo": "Connect a GitHub repo before forking agents.",
  "not-found": "That agent no longer exists.",
  "invalid-source": "The source agent file couldn't be read.",
};

// Fork an agent into the current user's owner-namespaced copy (ryw.<base-slug>).
// The forker becomes the owner, so it lands in their "Mine + Starred" view.
export async function forkAgentAction(args: {
  workspaceSlug: string;
  agentName: string;
}): Promise<{ ok: true; agentName: string } | { ok: false; error: string }> {
  const auth = await authorizeWorkspace(args.workspaceSlug, "operator");
  if (!auth.ok) {
    if (auth.reason === "denied") return { ok: false, error: DENIED_MESSAGE };
    notFound();
  }
  const { workspace, userId } = auth;

  // A locked agent is change-controlled — it can't be copied out either.
  if (await isAgentLocked(workspace.id, args.agentName)) {
    return { ok: false, error: "This agent is locked and can't be forked." };
  }

  const session = await getServerSession();
  const email = session?.user.email ?? "";

  const result = await forkAgent(workspace.id, userId, email, args.agentName);
  if (!result.ok) {
    return {
      ok: false,
      error: FORK_ERROR_MESSAGE[result.error] ?? "Couldn't fork the agent.",
    };
  }
  await writeAuditEvent({
    workspaceId: workspace.id,
    actorUserId: userId,
    source: "human_action",
    kind: "agent.forked",
    targetType: "agent",
    targetId: result.agentName,
    agentName: result.agentName,
    payload: { from: args.agentName },
  });
  revalidatePath(`/${args.workspaceSlug}`, "layout");
  return { ok: true, agentName: result.agentName };
}
