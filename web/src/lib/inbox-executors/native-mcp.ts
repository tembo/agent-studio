import "server-only";

import {
  getNativeConnection,
  listNativeConnectionsForUser,
} from "@/lib/connections";
import type { McpProviderSlug } from "@/lib/mcp-providers";
import { callNativeMcpTool } from "@/lib/native-mcp-tools";
import { getUsableNativeMcpCredentials } from "@/lib/native-mcp-credentials";

import type { InboxExecutor } from "./index";

// Executes inbox options whose `execute.provider === "native-mcp"` by calling a
// single tool on the human's native MCP connection. The producing agent stores
// the tool name as `op` and, in `params`, which connection to use plus the tool
// arguments — so the click reaches the SAME MCP server the agent itself used
// (e.g. Dialed `complete_task`, Linear issue update, Attio task complete):
//
//   execute:
//     provider: native-mcp
//     op: complete_task                  # the MCP tool to call
//     params:
//       connectionType: dialed           # native MCP provider slug
//       connectionName: default          # connection name (default "default")
//       toolArgs: { id: "<task-uuid>" }  # arguments for the tool
//
// The call runs against the same per-user OAuth token the agent ran with, so it
// can only do what that connection's scopes allow.
export const nativeMcpExecutor: InboxExecutor = async ({
  workspaceId,
  userId,
  op,
  params,
}) => {
  const connectionType =
    typeof params?.connectionType === "string" ? params.connectionType : null;
  const connectionName =
    typeof params?.connectionName === "string" && params.connectionName.trim()
      ? params.connectionName
      : "default";
  const toolArgs =
    params?.toolArgs && typeof params.toolArgs === "object"
      ? (params.toolArgs as Record<string, unknown>)
      : {};

  if (!op) throw new Error("native-mcp action is missing a tool name (op).");
  if (!connectionType) {
    throw new Error("native-mcp action is missing params.connectionType.");
  }
  if (!userId) throw new Error("native-mcp action requires a signed-in user.");

  // Prefer the exact name the agent declared, but tolerate a name mismatch:
  // the agent hardcodes a name (e.g. "default") while the human may have named
  // their connection something else ("tembo"). If the exact name misses, fall
  // back to their sole ACTIVE connection of this provider type — unambiguous
  // and what they obviously mean. Only bail when there are zero, or several
  // (then we genuinely can't guess which account to act as).
  let conn = await getNativeConnection(
    workspaceId,
    userId,
    connectionType as McpProviderSlug,
    connectionName,
  );
  if (!conn) {
    const ofType = (await listNativeConnectionsForUser(workspaceId, userId)).filter(
      (c) => c.type === connectionType && c.status === "active",
    );
    if (ofType.length === 1) {
      conn = ofType[0];
    } else if (ofType.length === 0) {
      throw new Error(
        `No "${connectionType}" connection for you — connect it under Connections, then retry.`,
      );
    } else {
      throw new Error(
        `You have several "${connectionType}" connections but none named "${connectionName}" — rename one to "${connectionName}" (or reconnect) so this action knows which account to use.`,
      );
    }
  }

  const creds = await getUsableNativeMcpCredentials(conn);
  if (!creds.access_token) {
    throw new Error(
      `The "${connectionType}" connection has no access token — reconnect it under Connections.`,
    );
  }

  await callNativeMcpTool(conn.mcpServerUrl, creds.access_token, op, toolArgs);
};
