import "server-only";

import {
  type AgentConnection,
  type AgentConnectionSource,
} from "@/lib/agent-format";
import { toolkitLabel } from "@/lib/composio-label";
import { listConnectionsForUser } from "@/lib/composio-connections";
import { listNativeConnectionsForUser } from "@/lib/connections";
import { getMcpProvider } from "@/lib/mcp-providers";
import { listSecretConnections } from "@/lib/secret-connections";

// Pre-flight: which of an agent's declared connections the run's acting user
// hasn't set up. Used to BLOCK a run before it starts (the wrapper would
// otherwise fail mid-run with a traceback) and to power the sidebar's
// "Action needed" prompts. Same slot logic as web/src/app/[workspace]/layout.tsx.
//
//   - composio / native-mcp: per-(user, slot) — the acting user must have an
//     ACTIVE connection for `${toolkit}:${name}`.
//   - secret: workspace-level — a secret with that slug must exist.

export type MissingConnection = {
  toolkit: string;
  name: string;
  source: AgentConnectionSource;
  /** Human label for messages, e.g. "Slack", "Attio", "clay". */
  label: string;
  /** Present when a matching native connection exists but cannot be used. */
  connectionStatus?: string;
  /** Sanitized refresh diagnostic persisted by the runtime. */
  connectionMessage?: string;
};

export function labelFor(
  toolkit: string,
  source: AgentConnectionSource,
): string {
  if (source === "native-mcp") {
    return getMcpProvider(toolkit)?.displayName ?? toolkitLabel(toolkit);
  }
  if (source === "secret") return toolkit;
  return toolkitLabel(toolkit);
}

// The per-user / per-workspace connection inventory, pre-bucketed into the
// lookups the missing-slot predicate needs. Built once per page (the sidebar
// reuses it across every agent) so we don't refetch per agent.
export type ConnectionSlotSets = {
  /** `${toolkit}:${name}` for each ACTIVE Composio connection. */
  composioSlots: Set<string>;
  /** Active Composio connection count per toolkit (single-slot fallback). */
  composioCountByToolkit: Map<string, number>;
  /** `${type}:${name}` for each active Native-MCP connection. */
  nativeSlots: Set<string>;
  /** Active Native-MCP connection count per provider (single-slot fallback). */
  nativeCountByProvider: Map<string, number>;
  /** Slugs of workspace-level secrets. */
  secretSlugs: Set<string>;
};

export function buildConnectionSlotSets(
  composio: { toolkit: string; name: string; status: string }[],
  native: { type: string; name: string; status: string }[],
  secrets: { slug: string }[],
): ConnectionSlotSets {
  const activeComposio = composio.filter((c) => c.status === "ACTIVE");
  const composioSlots = new Set(
    activeComposio.map((c) => `${c.toolkit}:${c.name}`),
  );
  const composioCountByToolkit = new Map<string, number>();
  for (const c of activeComposio) {
    composioCountByToolkit.set(
      c.toolkit,
      (composioCountByToolkit.get(c.toolkit) ?? 0) + 1,
    );
  }
  const activeNative = native.filter((c) => c.status === "active");
  const nativeSlots = new Set(activeNative.map((c) => `${c.type}:${c.name}`));
  const nativeCountByProvider = new Map<string, number>();
  for (const c of activeNative) {
    nativeCountByProvider.set(
      c.type,
      (nativeCountByProvider.get(c.type) ?? 0) + 1,
    );
  }
  const secretSlugs = new Set(secrets.map((s) => s.slug));
  return {
    composioSlots,
    composioCountByToolkit,
    nativeSlots,
    nativeCountByProvider,
    secretSlugs,
  };
}

// Single source of truth for "is this agent connection set up for the user?".
// Both the run-blocking pre-flight (findMissingConnections) and the sidebar's
// "Action needed" list call this, so they can't drift. `toolkit`/`name` must
// already be trimmed + lowercased (name defaulted to "default").
//
// The single-connection fallback (mirrors build_native_mcp_toolsets and
// build_composio_toolset): an agent pins a slot by name, but users routinely
// have the provider under a different name (e.g. an agent declares `gmail`
// under `tembo` while the user authorized `ry-tembo`); when there's exactly
// one active connection for that toolkit/provider, the runtime uses it
// regardless of the declared name — so it isn't "missing". Applies to both
// Composio and Native-MCP so the sidebar and runtime agree.
export function isAgentConnectionMissing(
  source: AgentConnectionSource,
  toolkit: string,
  name: string,
  sets: ConnectionSlotSets,
): boolean {
  if (source === "secret") return !sets.secretSlugs.has(toolkit);
  if (source === "native-mcp") {
    return (
      !sets.nativeSlots.has(`${toolkit}:${name}`) &&
      sets.nativeCountByProvider.get(toolkit) !== 1
    );
  }
  return (
    !sets.composioSlots.has(`${toolkit}:${name}`) &&
    sets.composioCountByToolkit.get(toolkit) !== 1
  );
}

export async function findMissingConnections(
  workspaceId: string,
  actingUserId: string,
  connections: AgentConnection[],
): Promise<MissingConnection[]> {
  if (connections.length === 0) return [];

  const [composio, native, secrets] = await Promise.all([
    listConnectionsForUser(workspaceId, actingUserId).catch(() => []),
    listNativeConnectionsForUser(workspaceId, actingUserId).catch(() => []),
    listSecretConnections(workspaceId).catch(() => []),
  ]);
  const sets = buildConnectionSlotSets(composio, native, secrets);

  const missing: MissingConnection[] = [];
  const seen = new Set<string>();
  for (const conn of connections) {
    const toolkit = conn.toolkit.trim().toLowerCase();
    const name = conn.name.trim().toLowerCase() || "default";
    if (!toolkit) continue;
    if (!isAgentConnectionMissing(conn.source, toolkit, name, sets)) continue;

    const key = `${conn.source}:${toolkit}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    missing.push({
      toolkit,
      name: conn.source === "secret" ? "default" : name,
      source: conn.source,
      label: labelFor(toolkit, conn.source),
      ...(conn.source === "native-mcp"
        ? (() => {
            const providerRows = native.filter((c) => c.type === toolkit);
            const matched =
              providerRows.find((c) => c.name === name) ??
              (providerRows.length === 1 ? providerRows[0] : undefined);
            return matched && matched.status !== "active"
              ? {
                  connectionStatus: matched.status,
                  connectionMessage: matched.refreshErrorMessage ?? undefined,
                }
              : {};
          })()
        : {}),
    });
  }
  return missing;
}

/** A one-line, run-now-friendly error for a missing-connection list. */
export function missingConnectionsMessage(
  missing: MissingConnection[],
  actingIsSelf: boolean,
): string {
  const labels = missing
    .map((m) => {
      const slot = m.name && m.name !== "default" ? ` (${m.name})` : "";
      return `${m.label}${slot}`;
    })
    .join(", ");
  const subject = actingIsSelf
    ? "You haven't connected"
    : "The selected member hasn't connected";
  const unhealthy = missing.filter((m) => m.connectionStatus);
  if (unhealthy.length > 0) {
    const owner = actingIsSelf ? "Your" : "The selected member's";
    const reasons = Array.from(
      new Set(unhealthy.map((m) => m.connectionMessage).filter(Boolean)),
    );
    const action =
      reasons.length > 0
        ? `${reasons.join(" ")} Then run again.`
        : "Reconnect under Connections, then run again.";
    return `${owner} connection needs attention: ${labels}. ${action}`;
  }
  const secretOnly = missing.every((m) => m.source === "secret");
  const where = secretOnly
    ? "Add it under Connections → Secrets"
    : "Authorize under Connections";
  return `${subject}: ${labels}. ${where}, then run again.`;
}
