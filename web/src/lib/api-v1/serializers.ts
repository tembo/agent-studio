import "server-only";

import type { ListedAgent } from "@/lib/workspace-agents";
import type { RunRecord } from "@/lib/runs-api";
import type { RunListItem } from "@/lib/runs-db";
import type { Automation } from "@/lib/automations-api";
import type { McpTool } from "@/lib/mcp-tools";
import type { WorkspaceComposioConnection } from "@/lib/composio-connections";
import type { WorkspaceConnection } from "@/lib/connections";
import type { SlackApp } from "@/lib/slack-apps";
import type { InboxItem } from "@/lib/inbox-api";

// Pure mappers from internal service-layer types to the public JSON shapes
// emitted by BOTH the REST API (/api/v1) and the MCP server (/mcp). Keeping
// them here (one place, no I/O) means the two surfaces stay byte-identical and
// the mapping is unit-testable without standing up a route. Resource bodies use
// camelCase to match the lib layer; Date fields are normalized to ISO strings
// so the contract doesn't depend on JSON.stringify's Date behavior.

export type SerializedAgent =
  | {
      name: string;
      filename: string;
      path: string;
      format: string;
      framework: string;
      valid: true;
      spec: unknown;
    }
  | {
      name: string;
      filename: string;
      path: string;
      format: string | null;
      valid: false;
      error: string;
      detail?: string;
    };

export function serializeAgent(a: ListedAgent): SerializedAgent {
  if (a.ok) {
    return {
      name: a.spec.name,
      filename: a.filename,
      path: a.path,
      format: a.format,
      framework: a.spec.framework,
      valid: true,
      spec: a.spec,
    };
  }
  return {
    name: a.filename.replace(/\.(yaml|yml|json)$/i, ""),
    filename: a.filename,
    path: a.path,
    format: a.format,
    valid: false,
    error: a.error,
    detail: a.detail,
  };
}

export type SerializedRun = {
  id: string;
  agentName: string;
  agentPath: string;
  userMessage: string;
  model: string;
  status: RunRecord["status"];
  output: string;
  streamedOutput: string | null;
  /** Safe user-facing failure copy. */
  errorMessage: string | null;
  failureCode: string | null;
  failureRecommendation: string | null;
  /** Privileged runner diagnostics; omitted for non-admin callers. */
  errorDetails?: string | null;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  trigger: RunRecord["trigger"];
  automationId: string | null;
  agentVersionLabel: string | null;
  runEnvironment: RunRecord["runEnvironment"];
};

/** Full run record (output, stream, safe failure copy, tokens). */
export function serializeRunRecord(
  r: RunRecord,
  options: { includeDiagnostics?: boolean } = {},
): SerializedRun {
  const serialized: SerializedRun = {
    id: r.id,
    agentName: r.agentName,
    agentPath: r.agentPath,
    userMessage: r.userMessage,
    model: r.model,
    status: r.status,
    output: r.output,
    streamedOutput: r.streamedOutput,
    errorMessage:
      r.status === "failed"
        ? (r.failureSummary ?? "The run ended unexpectedly.")
        : null,
    failureCode:
      r.status === "failed" ? (r.failureCode ?? "unknown") : null,
    failureRecommendation:
      r.status === "failed"
        ? (r.failureRecommendation ??
          "Try again. If it keeps failing, ask a workspace admin to investigate.")
        : null,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    tokensInput: r.tokensInput,
    tokensOutput: r.tokensOutput,
    trigger: r.trigger,
    automationId: r.automationId,
    agentVersionLabel: r.agentVersionLabel,
    runEnvironment: r.runEnvironment,
  };
  if (options.includeDiagnostics && r.status === "failed" && r.errorMessage) {
    serialized.errorDetails = r.errorMessage;
  }
  return serialized;
}

export type SerializedRunListItem = {
  id: string;
  agentName: string;
  status: RunListItem["status"];
  trigger: RunListItem["trigger"];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  userMessagePreview: string;
  errorMessagePreview: string | null;
  costUsd: number | null;
  agentVersionLabel: string | null;
  runEnvironment: RunListItem["runEnvironment"];
};

/** Compact list row — the GET /runs body. No full output (use GET /runs/[id]). */
export function serializeRunListItem(r: RunListItem): SerializedRunListItem {
  return {
    id: r.id,
    agentName: r.agentName,
    status: r.status,
    trigger: r.trigger,
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    userMessagePreview: r.userMessagePreview,
    errorMessagePreview: r.errorMessagePreview,
    costUsd: r.costUsd,
    agentVersionLabel: r.agentVersionLabel,
    runEnvironment: r.runEnvironment,
  };
}

export type SerializedAutomation = {
  id: string;
  name: string;
  agentName: string;
  cron: string;
  inputMessage: string;
  enabled: boolean;
  ownerUserId: string;
  useDraft: boolean;
  lastFiredAt: string | null;
  lastFireError: string | null;
  lastFireEventId: string | null;
  createdAt: string;
  updatedAt: string;
};

export function serializeAutomation(a: Automation): SerializedAutomation {
  return {
    id: a.id,
    name: a.name,
    agentName: a.agentName,
    cron: a.cron,
    inputMessage: a.inputMessage,
    enabled: a.enabled,
    ownerUserId: a.ownerUserId,
    useDraft: a.useDraft,
    lastFiredAt: a.lastFiredAt ? a.lastFiredAt.toISOString() : null,
    lastFireError: a.lastFireError,
    lastFireEventId: a.lastFireEventId,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export type SerializedTool = {
  source: McpTool["source"];
  provider: string;
  connectionName: string;
  slug: string;
  displayName: string | null;
  description: string | null;
};

/** One cached tool the key's user can call — `slug` is what goes in an agent's
 *  `connections: tools:[...]`, which is the main reason to expose this. */
export function serializeTool(t: McpTool): SerializedTool {
  return {
    source: t.source,
    provider: t.provider,
    connectionName: t.connectionName,
    slug: t.slug,
    displayName: t.displayName,
    description: t.description,
  };
}

export type SerializedConnections = {
  composio: {
    provider: string;
    name: string;
    status: string;
  }[];
  nativeMcp: {
    provider: string;
    name: string;
    status: string;
    authType: string;
    tokenExpiresAt: string | null;
  }[];
};

/** The key user's per-user connection status across both substrates. Names +
 *  statuses only — no tokens (those live encrypted and never leave the server). */
export function serializeConnections(
  composio: WorkspaceComposioConnection[],
  nativeMcp: WorkspaceConnection[],
): SerializedConnections {
  return {
    composio: composio.map((c) => ({ provider: c.toolkit, name: c.name, status: c.status })),
    nativeMcp: nativeMcp.map((c) => ({
      provider: c.type,
      name: c.name,
      status: c.status,
      authType: c.authType,
      tokenExpiresAt: c.tokenExpiresAt ? c.tokenExpiresAt.toISOString() : null,
    })),
  };
}

export type SerializedSlackApp = {
  id: string;
  name: string;
  status: SlackApp["status"];
  teamId: string | null;
  botUserId: string | null;
  defaultOwnerUserId: string;
  agentLabels: string[];
  hasBotToken: boolean;
  createdAt: string;
  updatedAt: string;
};

/** SlackApp is already secret-safe (secrets are booleans). */
export function serializeSlackApp(a: SlackApp): SerializedSlackApp {
  return {
    id: a.id,
    name: a.name,
    status: a.status,
    teamId: a.teamId,
    botUserId: a.botUserId,
    defaultOwnerUserId: a.defaultOwnerUserId,
    agentLabels: a.agentLabels,
    hasBotToken: a.hasBotToken,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export type SerializedInboxItem = {
  id: string;
  source: string;
  externalRef: string | null;
  url: string | null;
  itemType: string;
  title: string;
  context: Record<string, unknown>;
  proposedAction: InboxItem["proposedAction"];
  finalAction: InboxItem["finalAction"];
  options: InboxItem["options"];
  /** Deep links to render as a "Links" list, beyond the single `url`. */
  links: InboxItem["links"];
  status: InboxItem["status"];
  assigneeKind: InboxItem["assigneeKind"];
  assigneeId: string | null;
  producedByRunId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  /** Source freshness marker (e.g. LinkedIn lastActivityAt, epoch ms). Lets a
   *  producer dedup: skip a thread it already surfaced unless it's newer. */
  externalTs: number | null;
  /** When set + future, the item is snoozed (hidden from the active inbox). */
  snoozedUntil: string | null;
};

/** One inbox item — the GET /inbox and GET /inbox/[id] body. The learning
 *  bookkeeping (improvementId, signalConsumedAt) stays internal. */
export function serializeInboxItem(i: InboxItem): SerializedInboxItem {
  return {
    id: i.id,
    source: i.source,
    externalRef: i.externalRef,
    url: i.url,
    itemType: i.itemType,
    title: i.title,
    context: i.context,
    proposedAction: i.proposedAction,
    finalAction: i.finalAction,
    options: i.options,
    links: i.links,
    status: i.status,
    assigneeKind: i.assigneeKind,
    assigneeId: i.assigneeId,
    producedByRunId: i.producedByRunId,
    createdBy: i.createdBy,
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
    resolvedAt: i.resolvedAt ? i.resolvedAt.toISOString() : null,
    externalTs: i.externalTs,
    snoozedUntil: i.snoozedUntil ? i.snoozedUntil.toISOString() : null,
  };
}
