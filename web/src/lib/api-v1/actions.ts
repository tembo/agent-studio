import "server-only";

import type { AuthorizeApiSuccess } from "@/lib/api-auth";
import { writeAuditEvent } from "@/lib/audit-db";
import type { AuditSource } from "@/lib/audit";
import { isAgentLocked } from "@/lib/agent-lock";
import {
  detectFormat,
  parseAgentContent,
  validateAgentName,
  type AgentFileFormat,
} from "@/lib/agent-format";
import { FRAMEWORKS, type Framework } from "@/lib/agent-framework";
import { createAutomation } from "@/lib/automations-api";
import {
  createSlackApp,
  deleteSlackApp,
  getSlackApp,
  getSlackAppSecrets,
  listSlackApps,
  updateSlackApp,
  type SlackApp,
} from "@/lib/slack-apps";
import { lookupUserByEmail, postMessage } from "@/lib/slack-api";
import {
  buildChatEditPrompt,
  buildCreateAgentPrompt,
  createTemboTask,
} from "@/lib/cap-api";
import { resolveTemboCredential } from "@/lib/tembo-credentials";
import { buildPromptConnectionContext } from "@/lib/prompt-connections";
import {
  findMissingConnections,
  missingConnectionsMessage,
} from "@/lib/connection-checks";
import { validateCron } from "@/lib/cron";
import {
  createImprovement,
  improvementMarker,
  setImprovementCommitted,
  setImprovementTask,
  type ImprovementSource,
} from "@/lib/improvements-api";
import { createRun, getRun } from "@/lib/runs-api";
import {
  claimInboxItem,
  completeInboxItem,
  createInboxItem,
  dismissInboxItem,
  getInboxItem,
  listInboxItems,
  setProposedAction,
  type InboxAction,
  type InboxItem,
  type InboxLink,
  type InboxOption,
  type ListInboxFilters,
} from "@/lib/inbox-api";
import { suggestSlug } from "@/lib/slugify";
import {
  getWorkspaceById,
  getWorkspaceRepo,
  listWorkspaceMembers,
} from "@/lib/workspace";
import { setAgentOwner } from "@/lib/agent-versions";
import { getAgentByName, resolveAgentForDispatch } from "@/lib/workspace-agents";

// Shared write-action service layer for BOTH the REST API (/api/v1) and the MCP
// server (/mcp). Each function takes the resolved auth context and returns a
// discriminated union { ok: true, ... } | { ok: false, status, error }. The
// caller maps that to an HTTP status (REST) or an MCP error result (MCP). Role
// gating happens at the caller's auth boundary (REST passes minRole "operator";
// MCP checks ctx.role) — these mirror the equivalent server actions
// (runNowAction, chatSubmitAction, createFromChatAction, createAutomation form).

export type ApiCtx = AuthorizeApiSuccess;

export type ActionFailure = { ok: false; status: number; error: string };

// Audit a mutation made through a programmatic surface (REST API or MCP).
// Stamps `via` (the surface) and the acting `apiKeyId` into the payload so the
// audit timeline can tell an API/MCP change apart from an in-app one and trace
// it back to a specific key. Mirrors the in-app server actions' writeAuditEvent
// calls; runs and improvements are intentionally NOT audited here — they live in
// their own tables and already project into the timeline (attributed to
// ctx.userId), so an explicit event would just duplicate them.
async function auditApiMutation(
  ctx: ApiCtx,
  e: {
    kind: string;
    targetType: string;
    targetId: string | null;
    agentName?: string | null;
    source?: AuditSource;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await writeAuditEvent({
    workspaceId: ctx.workspace.id,
    actorUserId: ctx.userId,
    source: e.source ?? "human_action",
    kind: e.kind,
    targetType: e.targetType,
    targetId: e.targetId,
    agentName: e.agentName ?? null,
    payload: { via: ctx.surface, apiKeyId: ctx.apiKeyId, ...e.payload },
  });
}

// ── trigger a run ─────────────────────────────────────────────────────

export type TriggerRunInput = {
  agent: string;
  message?: string;
  preferDraft?: boolean;
  /** The orchestrator run that triggered this sub-agent through /mcp. */
  orchestratorRunId?: string;
};

export async function triggerRun(
  ctx: ApiCtx,
  input: TriggerRunInput,
): Promise<{ ok: true; runId: string } | ActionFailure> {
  const dispatch = await resolveAgentForDispatch(ctx.workspace.id, input.agent, {
    preferDraft: input.preferDraft ?? false,
  });
  if (!dispatch.ok) {
    const status = dispatch.error.kind === "not-found" ? 404 : 422;
    return { ok: false, status, error: dispatch.error.message };
  }
  const r = dispatch.resolved;

  // Same pre-flight the UI's Run-now uses: block a run the acting user can't
  // complete (a declared connection they haven't authorized) with an
  // actionable message rather than a mid-run traceback.
  const missing = await findMissingConnections(
    ctx.workspace.id,
    ctx.userId,
    r.connections,
  );
  if (missing.length > 0) {
    return { ok: false, status: 422, error: missingConnectionsMessage(missing, true) };
  }

  try {
    const res = await createRun({
      workspaceId: ctx.workspace.id,
      userId: ctx.userId,
      agentName: r.agentName,
      agentPath: r.agentPath,
      model: r.model,
      framework: r.framework,
      specContent: r.specContent,
      specFormat: r.specFormat,
      toolsModuleContent: r.toolsModuleContent,
      skillsContent: r.skillsContent,
      userMessage: input.message ?? "",
      trigger: "manual",
      agentVersionId: r.versionId,
      agentVersionLabel: r.versionLabel,
      orchestratorRunId: input.orchestratorRunId,
      delivery: r.delivery,
    });
    // Not audited explicitly: the run row projects into the audit timeline as a
    // run.* event attributed to ctx.userId (see auditApiMutation note).
    return { ok: true, runId: res.runId };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: err instanceof Error ? err.message : "Couldn't queue the run.",
    };
  }
}

// ── validate a spec ───────────────────────────────────────────────────

export type ValidateSpecInput = {
  content: string;
  format?: AgentFileFormat;
  filename?: string;
};

export type ValidateSpecResult =
  | { valid: true; framework: Framework; name: string; format: AgentFileFormat }
  | { valid: false; error: string; detail?: string };

export function validateSpec(
  input: ValidateSpecInput,
): { ok: true; result: ValidateSpecResult } | ActionFailure {
  const format =
    input.format ?? (input.filename ? detectFormat(input.filename) : null);
  if (!format) {
    return {
      ok: false,
      status: 400,
      error: "provide `format` (yaml|json) or a `filename` with a known extension",
    };
  }
  const parsed = parseAgentContent(input.content, format);
  if (!parsed.ok) {
    return { ok: true, result: { valid: false, error: parsed.error, detail: parsed.detail } };
  }
  return {
    ok: true,
    result: {
      valid: true,
      framework: parsed.spec.framework,
      name: parsed.spec.name,
      format: parsed.format,
    },
  };
}

// ── create an automation ──────────────────────────────────────────────

export type CreateAutomationInput = {
  name: string;
  agent: string;
  cron: string;
  inputMessage?: string;
  enabled?: boolean;
  useDraft?: boolean;
};

export async function createAutomationFor(
  ctx: ApiCtx,
  input: CreateAutomationInput,
): Promise<{ ok: true; automation: Awaited<ReturnType<typeof createAutomation>> } | ActionFailure> {
  if (!input.name.trim()) return { ok: false, status: 400, error: "name is required" };
  if (!input.agent.trim()) return { ok: false, status: 400, error: "agent is required" };

  const cron = validateCron(input.cron);
  if (!cron.ok) return { ok: false, status: 400, error: cron.error };

  // The agent must exist so we don't schedule a run that can never resolve.
  const agent = await getAgentByName(ctx.workspace.id, input.agent);
  if (!agent) return { ok: false, status: 404, error: `agent "${input.agent}" not found` };

  const automation = await createAutomation({
    workspaceId: ctx.workspace.id,
    name: input.name.trim(),
    agentName: input.agent,
    cron: input.cron,
    inputMessage: input.inputMessage ?? "",
    enabled: input.enabled ?? true,
    userId: ctx.userId,
    useDraft: input.useDraft ?? false,
  });
  await auditApiMutation(ctx, {
    kind: "automation.created",
    targetType: "automation",
    targetId: automation.id,
    agentName: input.agent,
    payload: { name: input.name.trim(), cron: input.cron, enabled: input.enabled ?? true },
  });
  return { ok: true, automation };
}

// ── request an agent change via the Tembo Coding Agent ────────────────

export type RequestAgentChangeInput = {
  /** Existing agent to edit (its declared name). Omit to create a new agent. */
  agent?: string;
  /** New agent display name (free text). Required when `agent` is omitted. */
  name?: string;
  /** Framework for a new agent. Defaults to pydantic-agentspec. */
  framework?: Framework;
  /** What to change / what the new agent should do. */
  description: string;
  /** Where this change originated. Defaults to 'chat'; the scheduler's learning
   *  pass passes 'learning' so the resulting improvement is tagged. */
  source?: ImprovementSource;
};

export type RequestAgentChangeResult = {
  improvementId: string;
  taskId: string;
  htmlUrl: string;
  status: string;
  kind: "edit" | "create";
  agentPath: string;
};

const FRAMEWORK_PATH: Record<Framework, { dir: string; ext: AgentFileFormat }> = {
  "pydantic-agentspec": { dir: "pydantic-agentspec", ext: "yaml" },
  "cargo-ai": { dir: "cargo-ai", ext: "json" },
};

// Not audited explicitly: this creates an improvement row, which projects into
// the audit timeline as an improvement.* event attributed to ctx.userId (see
// the auditApiMutation note above).
export async function requestAgentChange(
  ctx: ApiCtx,
  input: RequestAgentChangeInput,
): Promise<{ ok: true; result: RequestAgentChangeResult } | ActionFailure> {
  const description = input.description.trim();
  if (!description) {
    return { ok: false, status: 400, error: "description is required" };
  }

  const repo = await getWorkspaceRepo(ctx.workspace.id);
  if (!repo) {
    return { ok: false, status: 409, error: "no repository connected to this workspace" };
  }
  const temboCredential = await resolveTemboCredential(
    ctx.workspace.id,
    ctx.userId,
  );
  if (!temboCredential) {
    return {
      ok: false,
      status: 409,
      error:
        "no personal or workspace fallback Tembo account is connected (Settings → Tembo Coding Agent)",
    };
  }
  const repositoryUrl = `https://github.com/${repo.owner}/${repo.name}`;

  let kind: "edit" | "create";
  let agentName: string;
  let agentPath: string;
  let prompt: string;

  if (input.agent) {
    // Edit an existing agent.
    const found = await getAgentByName(ctx.workspace.id, input.agent);
    if (!found) return { ok: false, status: 404, error: `agent "${input.agent}" not found` };
    if (!found.agent.ok) {
      return {
        ok: false,
        status: 422,
        error: `agent file failed to parse: ${found.agent.error}`,
      };
    }
    // A locked agent is change-controlled — no in-app edits (chat / improve);
    // it changes only via direct repo PRs.
    if (await isAgentLocked(ctx.workspace.id, found.agent.spec.name)) {
      return {
        ok: false,
        status: 409,
        error: "this agent is locked — changes must go through a repo PR",
      };
    }
    kind = "edit";
    agentName = found.agent.spec.name;
    agentPath = found.agent.path;
    const row = await createImprovement({
      workspaceId: ctx.workspace.id,
      runId: null,
      agentName,
      agentPath,
      improvementText: description,
      delivery: ctx.workspace.commitMode,
      source: input.source,
      userId: ctx.userId,
    });
    prompt = buildChatEditPrompt({
      agentPath,
      improvement: description,
      improvementMarker: improvementMarker(row.id),
      commitMode: ctx.workspace.commitMode,
      defaultBranch: repo.defaultBranch,
      repositoryUrl,
      ...(await buildPromptConnectionContext(
        ctx.workspace.id,
        ctx.userId,
        Math.floor(Date.now() / 1000),
      )),
    });
    return finishTask({
      ctx,
      apiKey: temboCredential.apiKey,
      repositoryUrl,
      repo,
      rowId: row.id,
      prompt,
      kind,
      agentPath,
    });
  }

  // Create a new agent.
  const displayName = (input.name ?? "").trim();
  if (!displayName) {
    return { ok: false, status: 400, error: "name is required to create a new agent" };
  }
  const framework: Framework = input.framework ?? "pydantic-agentspec";
  if (!(FRAMEWORKS as readonly string[]).includes(framework)) {
    return { ok: false, status: 400, error: `unknown framework "${framework}"` };
  }
  const agentSlug = suggestSlug(displayName);
  if (!validateAgentName(agentSlug)) {
    return { ok: false, status: 400, error: "name must yield a valid slug (2+ alphanumerics)" };
  }
  const collision = await getAgentByName(ctx.workspace.id, agentSlug);
  if (collision) {
    return { ok: false, status: 409, error: `an agent named "${agentSlug}" already exists` };
  }

  const { dir, ext } = FRAMEWORK_PATH[framework];
  kind = "create";
  agentName = agentSlug;
  agentPath = `agents/${dir}/${agentSlug}.${ext}`;

  const row = await createImprovement({
    workspaceId: ctx.workspace.id,
    runId: null,
    agentName: agentSlug,
    agentPath,
    improvementText: description,
    kind: "create",
    delivery: ctx.workspace.commitMode,
    source: input.source,
    userId: ctx.userId,
  });

  // The creator owns the new agent, so it shows in their "Mine + Starred" view
  // when it lands. Keyed by agent_name; harmless if the create never merges.
  await setAgentOwner(ctx.workspace.id, agentSlug, ctx.userId, ctx.userId);

  // Surface the user's authorized connection slots (Composio + native MCP) so
  // CAP writes real slot names instead of `default` (it reads the repo, not the
  // TAS DB) and can look up native tool slugs at this instance's /for-agents.
  prompt = buildCreateAgentPrompt({
    framework,
    agentName: agentSlug,
    title: displayName,
    agentPath,
    description,
    improvementMarker: improvementMarker(row.id),
    commitMode: ctx.workspace.commitMode,
    defaultBranch: repo.defaultBranch,
    repositoryUrl,
    ...(await buildPromptConnectionContext(
      ctx.workspace.id,
      ctx.userId,
      Math.floor(Date.now() / 1000),
    )),
  });
  return finishTask({
    ctx,
    apiKey: temboCredential.apiKey,
    repositoryUrl,
    repo,
    rowId: row.id,
    prompt,
    kind,
    agentPath,
  });
}

/** Shared tail: POST the task to CAP, record it on the improvement row, return. */
async function finishTask(args: {
  ctx: ApiCtx;
  apiKey: string;
  repositoryUrl: string;
  repo: { defaultBranch: string };
  rowId: string;
  prompt: string;
  kind: "edit" | "create";
  agentPath: string;
}): Promise<{ ok: true; result: RequestAgentChangeResult } | ActionFailure> {
  const res = await createTemboTask({
    apiKey: args.apiKey,
    input: {
      prompt: args.prompt,
      repositoryUrl: args.repositoryUrl,
      targetBranch: args.repo.defaultBranch,
    },
  });
  if (!res.ok) {
    // Include the upstream status + response body so a failing dispatch is
    // diagnosable from the caller's error alone. Kind-only ("http") proved
    // undebuggable in the field. Returning the body to the authorized caller
    // matches what the chat UI already shows (formatCapError); it's LOGGING
    // the body that #44 forbids — it can echo the submitted prompt.
    const detail =
      res.error.kind === "http"
        ? `HTTP ${res.error.status}: ${res.error.body.slice(0, 300) || "(no body)"}`
        : res.error.kind === "network"
          ? `network: ${res.error.message}`
          : res.error.kind;
    return {
      ok: false,
      status: 502,
      error: `Tembo Coding Agent rejected the request (${detail})`,
    };
  }

  if (args.ctx.workspace.commitMode === "direct") {
    await setImprovementCommitted({
      id: args.rowId,
      temboTaskId: res.result.taskId,
      temboTaskHtmlUrl: res.result.htmlUrl,
    });
  } else {
    await setImprovementTask({
      id: args.rowId,
      temboTaskId: res.result.taskId,
      temboTaskHtmlUrl: res.result.htmlUrl,
    });
  }

  return {
    ok: true,
    result: {
      improvementId: args.rowId,
      taskId: res.result.taskId,
      htmlUrl: res.result.htmlUrl,
      status: res.result.status,
      kind: args.kind,
      agentPath: args.agentPath,
    },
  };
}

// ── Tasks Inbox ───────────────────────────────────────────────────────
// Shared inbox actions for the agent-facing surfaces (MCP + REST). Agents
// PRODUCE items (need a human) and ACT ON them (claim → propose → complete) as
// peers with humans on one queue. In this slice `completeInboxItemFor` only
// RECORDS the (proposed, final) signal — the batched learning pass (scheduler)
// turns accumulated signals into one improvement later, so there's no per-signal
// PR here. The human-facing in-app submit lives in the /inbox page's server
// action (session auth), not this programmatic layer.

/** Resolve the agent name of the run calling /mcp, so an agent claiming or
 *  completing an item is recorded as that agent (not the underlying user). */
async function actingAgentName(
  ctx: ApiCtx,
  orchestratorRunId: string | undefined,
): Promise<string | null> {
  if (!orchestratorRunId) return null;
  try {
    const run = await getRun(orchestratorRunId, ctx.workspace.id);
    return run?.agentName ?? null;
  } catch {
    return null;
  }
}

export type ProduceInboxItemInput = {
  itemType: string;
  title: string;
  source?: string;
  externalRef?: string;
  /** Deep link to the source object (issue/ticket/record/task URL). */
  url?: string;
  context?: Record<string, unknown> | string;
  proposedAction?: InboxAction;
  /** Action menu rendered as buttons; one may be `recommended`. */
  options?: InboxOption[];
  /** Deep links to render as a clickable "Links" list (e.g. the tickets behind
   *  one triage item). Sanitized to http(s) before persisting. */
  links?: InboxLink[];
  /** Source's latest-activity time (epoch ms); newer than stored reopens the item. */
  externalTs?: number;
  /** The run producing this item (set when called from /mcp inside a run). */
  orchestratorRunId?: string;
};

// Keep only well-formed http(s) links, de-dupe by url (first occurrence wins, so
// an explicit or labelled link beats a later bare one), and cap the count. The
// url reaches an <a href> directly, so a non-http(s) scheme (javascript:,
// data:) must never be stored. Returns null when nothing survives so the column
// stays clean.
const MAX_INBOX_LINKS = 50;
export function sanitizeInboxLinks(
  links: InboxLink[] | undefined,
): InboxLink[] | null {
  if (!Array.isArray(links) || links.length === 0) return null;
  const clean: InboxLink[] = [];
  const seen = new Set<string>();
  for (const l of links) {
    const url = typeof l?.url === "string" ? l.url.trim() : "";
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const label = typeof l?.label === "string" ? l.label.trim() : "";
    clean.push(label ? { label, url } : { url });
    if (clean.length >= MAX_INBOX_LINKS) break;
  }
  return clean.length > 0 ? clean : null;
}

// Pull every link out of an item's content so the human gets a clickable Links
// list even when the agent didn't populate `links` explicitly. Sources: the
// proposed-action text (Markdown `[label](url)` keeps its label; bare urls too)
// and the raw context payload (bare urls). De-duping + http(s)-only filtering
// happens in sanitizeInboxLinks once these are merged with any explicit links.
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL_RE = /https?:\/\/[^\s)"'<>\]]+/g;
// Sentence punctuation to strip off the tail of a bare URL (e.g. "see
// https://x/foo."). Done with a linear scan rather than an anchored
// `/[.,;:!?]+$/` regex, whose greedy `+` backtracks quadratically on a long run
// of these chars not at end-of-string — a ReDoS on agent-supplied content.
const TRAILING_PUNCT = new Set([".", ",", ";", ":", "!", "?"]);
function trimTrailingPunct(s: string): string {
  let end = s.length;
  while (end > 0 && TRAILING_PUNCT.has(s[end - 1])) end--;
  return s.slice(0, end);
}
export function extractInboxLinks(input: ProduceInboxItemInput): InboxLink[] {
  const out: InboxLink[] = [];
  const text = input.proposedAction?.text ?? "";
  // Markdown links first so their label is what survives de-duping.
  for (const m of text.matchAll(MARKDOWN_LINK_RE)) {
    out.push({ label: m[1].trim(), url: m[2] });
  }
  // Bare urls across the proposed text + the raw context payload.
  const haystack = `${text} ${JSON.stringify(input.context ?? {})}`;
  for (const m of haystack.matchAll(BARE_URL_RE)) {
    out.push({ url: trimTrailingPunct(m[0]) });
  }
  return out;
}

export async function produceInboxItemFor(
  ctx: ApiCtx,
  input: ProduceInboxItemInput,
): Promise<{ ok: true; item: InboxItem } | ActionFailure> {
  const title = input.title?.trim();
  if (!title) return { ok: false, status: 400, error: "title is required" };
  const itemType = input.itemType?.trim();
  if (!itemType) return { ok: false, status: 400, error: "itemType is required" };

  const producedByRunId = input.orchestratorRunId ?? null;
  const item = await createInboxItem({
    workspaceId: ctx.workspace.id,
    source: input.source?.trim() || "agent",
    externalRef: input.externalRef ?? null,
    url: input.url?.trim() || null,
    itemType,
    title,
    // Accept a plain-string context (a common model mistake — the field is a
    // JSON object) by wrapping it as { text } instead of rejecting the call.
    context:
      typeof input.context === "string"
        ? { text: input.context }
        : (input.context ?? {}),
    proposedAction: input.proposedAction ?? null,
    options: input.options ?? null,
    // Explicit links first (they win de-duping + keep their labels), then every
    // link auto-extracted from the item's text + context.
    links: sanitizeInboxLinks([
      ...(input.links ?? []),
      ...extractInboxLinks(input),
    ]),
    externalTs: input.externalTs ?? null,
    // A proposal (or an action menu) ready for review is awaiting_human;
    // otherwise it's open for a human or agent to pick up and propose against.
    status: input.proposedAction || input.options?.length ? "awaiting_human" : "open",
    producedByRunId,
    // Provenance lives on produced_by_run_id; created_by is reserved for the
    // person who filed it (null when an agent did).
    createdBy: producedByRunId ? null : ctx.userId,
    // Owner = the acting user (the run's identity for agent pushes, or the
    // filer). Inboxes are private and scope reads/mutations to this.
    ownerUserId: ctx.userId,
  });
  await auditApiMutation(ctx, {
    kind: "inbox.produced",
    targetType: "inbox_item",
    targetId: item.id,
    payload: { source: item.source, itemType: item.itemType },
  });
  return { ok: true, item };
}

export async function listInboxItemsFor(
  ctx: ApiCtx,
  filters: ListInboxFilters = {},
  limit?: number,
): Promise<{ ok: true; items: InboxItem[] }> {
  const items = await listInboxItems(ctx.workspace.id, ctx.userId, filters, limit);
  return { ok: true, items };
}

export async function getInboxItemFor(
  ctx: ApiCtx,
  id: string,
): Promise<{ ok: true; item: InboxItem } | ActionFailure> {
  const item = await getInboxItem(id, ctx.workspace.id, ctx.userId);
  if (!item) return { ok: false, status: 404, error: `no inbox item "${id}"` };
  return { ok: true, item };
}

export async function claimInboxItemFor(
  ctx: ApiCtx,
  input: { id: string; orchestratorRunId?: string },
): Promise<{ ok: true; item: InboxItem } | ActionFailure> {
  const agent = await actingAgentName(ctx, input.orchestratorRunId);
  const ok = agent
    ? await claimInboxItem(input.id, ctx.workspace.id, "agent", agent, ctx.userId)
    : await claimInboxItem(input.id, ctx.workspace.id, "human", ctx.userId, ctx.userId);
  if (!ok) {
    return { ok: false, status: 409, error: "item not found or already claimed" };
  }
  const item = await getInboxItem(input.id, ctx.workspace.id, ctx.userId);
  return { ok: true, item: item! };
}

export async function proposeInboxActionFor(
  ctx: ApiCtx,
  input: { id: string; proposedAction: InboxAction },
): Promise<{ ok: true; item: InboxItem } | ActionFailure> {
  if (!input.proposedAction || (!input.proposedAction.text && !input.proposedAction.fields)) {
    return { ok: false, status: 400, error: "proposedAction must have text or fields" };
  }
  const ok = await setProposedAction(
    input.id,
    ctx.workspace.id,
    input.proposedAction,
    ctx.userId,
  );
  if (!ok) {
    return { ok: false, status: 409, error: "item not found or not in a proposable state" };
  }
  const item = await getInboxItem(input.id, ctx.workspace.id, ctx.userId);
  return { ok: true, item: item! };
}

export async function completeInboxItemFor(
  ctx: ApiCtx,
  input: { id: string; finalAction: InboxAction },
): Promise<{ ok: true; item: InboxItem } | ActionFailure> {
  if (!input.finalAction || (!input.finalAction.text && !input.finalAction.fields)) {
    return { ok: false, status: 400, error: "finalAction must have text or fields" };
  }
  const ok = await completeInboxItem(
    input.id,
    ctx.workspace.id,
    input.finalAction,
    ctx.userId,
  );
  if (!ok) {
    return { ok: false, status: 409, error: "item not found or already resolved" };
  }
  const item = await getInboxItem(input.id, ctx.workspace.id, ctx.userId);
  // Recorded as a HITL response even when an autonomous agent completes it —
  // the (proposed, final) pair is the signal the learning pass batches later.
  await auditApiMutation(ctx, {
    source: "hitl_response",
    kind: "inbox.completed",
    targetType: "inbox_item",
    targetId: input.id,
    payload: { itemType: item!.itemType, source: item!.source },
  });
  return { ok: true, item: item! };
}

export async function dismissInboxItemFor(
  ctx: ApiCtx,
  input: { id: string },
): Promise<{ ok: true } | ActionFailure> {
  const ok = await dismissInboxItem(input.id, ctx.workspace.id, ctx.userId);
  if (!ok) {
    return { ok: false, status: 409, error: "item not found or already resolved" };
  }
  await auditApiMutation(ctx, {
    kind: "inbox.dismissed",
    targetType: "inbox_item",
    targetId: input.id,
  });
  return { ok: true };
}

// ── System-context agent change (scheduler learning pass) ─────────────
// The batched learning loop runs in the scheduler, which has no authenticated
// request — but requestAgentChange only reads ctx.workspace (id + commitMode)
// and ctx.userId (the improvement's created_by). Synthesize a minimal ApiCtx
// attributed to the learning config's owner so the existing improvement -> CAP
// pipeline is reused verbatim (one PR per batch). role/apiKeyId/surface are
// unused by requestAgentChange; we set placeholder-valid values.

export async function requestAgentChangeSystem(
  workspaceId: string,
  ownerUserId: string,
  input: { agent: string; description: string },
): Promise<{ ok: true; result: RequestAgentChangeResult } | ActionFailure> {
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) {
    return { ok: false, status: 404, error: "workspace not found" };
  }
  const ctx: ApiCtx = {
    ok: true,
    workspace,
    userId: ownerUserId,
    role: "operator",
    apiKeyId: "system:learning",
    surface: "api",
  };
  return requestAgentChange(ctx, { ...input, source: "learning" });
}

// ── Slack apps (workspace_admin) ──────────────────────────────────────
// Mirrors the Settings → Slack apps actions. Creation is just metadata
// (name + owner + which agent labels the bot may launch); the bot token and
// full setup come later through the browser OAuth install flow
// (/api/slack/{appId}/install) — the app is created in a `configuring` state
// and isn't live until that runs. Secrets are optional and only written when
// supplied. Role gating is the caller's job (REST passes workspace_admin; MCP
// checks ctx.role).

const SLACK_NAME_MAX = 35; // Slack's app-name limit

/** Normalize agent labels the way the UI does: lowercase, trimmed, de-duped. */
function normalizeLabels(labels: string[]): string[] {
  return Array.from(
    new Set(labels.map((s) => s.trim().toLowerCase()).filter(Boolean)),
  );
}

/** Look up a workspace's Slack app, treating a malformed id as not-found
 *  rather than letting Postgres throw on an invalid uuid (clean 404, not 500). */
async function findSlackApp(workspaceId: string, id: string): Promise<SlackApp | null> {
  try {
    return await getSlackApp(workspaceId, id);
  } catch {
    return null;
  }
}

/** Owner must be a member of the workspace (defaults to the caller). */
async function resolveOwner(
  ctx: ApiCtx,
  ownerUserId: string | undefined,
): Promise<{ ok: true; ownerUserId: string } | ActionFailure> {
  if (!ownerUserId || ownerUserId === ctx.userId) {
    return { ok: true, ownerUserId: ctx.userId };
  }
  const members = await listWorkspaceMembers(ctx.workspace.id);
  if (!members.some((m) => m.userId === ownerUserId)) {
    return { ok: false, status: 400, error: "defaultOwnerUserId must be a member of this workspace" };
  }
  return { ok: true, ownerUserId };
}

export type CreateSlackAppApiInput = {
  name: string;
  agentLabels?: string[];
  defaultOwnerUserId?: string;
  slackAppId?: string | null;
  signingSecret?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
};

export async function createSlackAppFor(
  ctx: ApiCtx,
  input: CreateSlackAppApiInput,
): Promise<{ ok: true; slackApp: SlackApp } | ActionFailure> {
  const name = input.name.trim();
  if (!name) return { ok: false, status: 400, error: "name is required" };
  if (name.length > SLACK_NAME_MAX) {
    return { ok: false, status: 400, error: `name must be ${SLACK_NAME_MAX} characters or fewer (Slack's limit)` };
  }
  const owner = await resolveOwner(ctx, input.defaultOwnerUserId);
  if (!owner.ok) return owner;

  try {
    const slackApp = await createSlackApp(
      ctx.workspace.id,
      {
        name,
        defaultOwnerUserId: owner.ownerUserId,
        agentLabels: normalizeLabels(input.agentLabels ?? []),
        slackAppId: input.slackAppId ?? null,
        signingSecret: input.signingSecret ?? null,
        clientId: input.clientId ?? null,
        clientSecret: input.clientSecret ?? null,
      },
      ctx.userId,
    );
    await auditApiMutation(ctx, {
      kind: "slack_app.created",
      targetType: "slack_app",
      targetId: slackApp.id,
      payload: { name },
    });
    return { ok: true, slackApp };
  } catch (e) {
    const dup = e instanceof Error && /unique|duplicate/i.test(e.message);
    return {
      ok: false,
      status: dup ? 409 : 502,
      error: dup ? "a Slack app with that name already exists" : "couldn't create the Slack app",
    };
  }
}

export type UpdateSlackAppApiInput = {
  name?: string;
  agentLabels?: string[];
  defaultOwnerUserId?: string;
  slackAppId?: string | null;
  clientId?: string | null;
  signingSecret?: string;
  clientSecret?: string;
};

export async function updateSlackAppFor(
  ctx: ApiCtx,
  id: string,
  input: UpdateSlackAppApiInput,
): Promise<{ ok: true; slackApp: SlackApp } | ActionFailure> {
  const existing = await findSlackApp(ctx.workspace.id, id);
  if (!existing) return { ok: false, status: 404, error: "slack app not found" };

  if (input.name !== undefined) {
    const n = input.name.trim();
    if (!n) return { ok: false, status: 400, error: "name cannot be empty" };
    if (n.length > SLACK_NAME_MAX) {
      return { ok: false, status: 400, error: `name must be ${SLACK_NAME_MAX} characters or fewer` };
    }
  }
  if (input.defaultOwnerUserId !== undefined) {
    const owner = await resolveOwner(ctx, input.defaultOwnerUserId);
    if (!owner.ok) return owner;
  }

  await updateSlackApp(ctx.workspace.id, id, {
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.defaultOwnerUserId !== undefined
      ? { defaultOwnerUserId: input.defaultOwnerUserId }
      : {}),
    ...(input.agentLabels !== undefined
      ? { agentLabels: normalizeLabels(input.agentLabels) }
      : {}),
    ...(input.slackAppId !== undefined ? { slackAppId: input.slackAppId } : {}),
    ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
    ...(input.signingSecret ? { signingSecret: input.signingSecret } : {}),
    ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
  });

  const updated = await getSlackApp(ctx.workspace.id, id);
  // getSlackApp can't be null here (we just updated it), but narrow for types.
  if (!updated) return { ok: false, status: 502, error: "slack app vanished after update" };
  await auditApiMutation(ctx, {
    kind: "slack_app.updated",
    targetType: "slack_app",
    targetId: id,
    payload: {
      name: updated.name,
      // Note which secrets were (re)written — never the values themselves.
      rotatedSecrets: [
        input.signingSecret ? "signing_secret" : null,
        input.clientSecret ? "client_secret" : null,
      ].filter(Boolean),
    },
  });
  return { ok: true, slackApp: updated };
}

export async function deleteSlackAppFor(
  ctx: ApiCtx,
  id: string,
): Promise<{ ok: true } | ActionFailure> {
  const existing = await findSlackApp(ctx.workspace.id, id);
  if (!existing) return { ok: false, status: 404, error: "slack app not found" };
  await deleteSlackApp(ctx.workspace.id, id);
  await auditApiMutation(ctx, {
    kind: "slack_app.deleted",
    targetType: "slack_app",
    targetId: id,
    payload: { name: existing.name },
  });
  return { ok: true };
}

export type SendSlackMessageApiInput = {
  text: string;
  /** DM target: a person's email (resolved to a real DM with a notification). */
  toEmail?: string;
  /** Or post to a channel/user by Slack id (e.g. "C0123", "U0123"). */
  channel?: string;
  /** Which Slack app to send from (by name). Optional when the workspace has
   *  exactly one installed app. */
  slackApp?: string;
  /** Reply in a thread instead of a top-level message. */
  threadTs?: string;
};

/**
 * Send a Slack message from one of the workspace's TAS-managed Slack apps —
 * the way to actually notify a person. (Composio's Slack "DM" posts to the
 * bot's own connected account, which the human never sees.) DMs by email or
 * posts to a channel. Returns the sent message's channel + ts.
 */
export async function sendSlackMessageFor(
  ctx: ApiCtx,
  input: SendSlackMessageApiInput,
): Promise<
  { ok: true; channel: string; ts: string | null } | ActionFailure
> {
  const text = input.text?.trim();
  if (!text) return { ok: false, status: 400, error: "`text` is required" };
  const hasEmail = !!input.toEmail?.trim();
  const hasChannel = !!input.channel?.trim();
  if (hasEmail === hasChannel) {
    return {
      ok: false,
      status: 400,
      error: "provide exactly one of `toEmail` or `channel`",
    };
  }

  // Resolve which Slack app to send from.
  const installed = (await listSlackApps(ctx.workspace.id)).filter(
    (a) => a.status === "installed" && a.hasBotToken,
  );
  if (installed.length === 0) {
    return {
      ok: false,
      status: 409,
      error:
        "no installed Slack app in this workspace — finish the OAuth install under Settings → Slack apps first",
    };
  }
  let app: SlackApp;
  const wanted = input.slackApp?.trim();
  if (wanted) {
    const match = installed.find(
      (a) => a.name.toLowerCase() === wanted.toLowerCase(),
    );
    if (!match) {
      return { ok: false, status: 404, error: `no installed Slack app named "${wanted}"` };
    }
    app = match;
  } else if (installed.length === 1) {
    app = installed[0];
  } else {
    return {
      ok: false,
      status: 400,
      error: `multiple Slack apps installed — pass \`slackApp\` (one of: ${installed
        .map((a) => a.name)
        .join(", ")})`,
    };
  }

  const secrets = await getSlackAppSecrets(app.id);
  if (!secrets?.botToken) {
    return { ok: false, status: 409, error: `Slack app "${app.name}" has no bot token` };
  }
  const token = secrets.botToken;

  // Resolve the destination channel: a channel id as-is, or an email → the
  // person's Slack user id (chat.postMessage to a user id opens a DM).
  let channel: string;
  if (hasChannel) {
    channel = input.channel!.trim();
  } else {
    const userId = await lookupUserByEmail(token, input.toEmail!.trim());
    if (!userId) {
      return {
        ok: false,
        status: 404,
        error: `no Slack user found for ${input.toEmail!.trim()} in this workspace`,
      };
    }
    channel = userId;
  }

  const res = await postMessage(token, {
    channel,
    text,
    ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
  });
  if (!res.ok) {
    return { ok: false, status: 502, error: `Slack rejected the message: ${res.error}` };
  }
  await auditApiMutation(ctx, {
    kind: "slack_message.sent",
    targetType: "slack_app",
    targetId: app.id,
    // Record where it went and how long it was — never the message body, which
    // can carry sensitive content (it's a real DM/channel post to a person).
    payload: {
      slackApp: app.name,
      destination: hasEmail ? `email:${input.toEmail!.trim()}` : `channel:${channel}`,
      textLength: text.length,
      threaded: !!input.threadTs,
    },
  });
  return { ok: true, channel, ts: res.ts ?? null };
}
