import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import type { AuthorizeApiSuccess } from "@/lib/api-auth";
import { db } from "@/lib/db";
import type { ResolvedDispatch } from "@/lib/workspace-agents";

export const outputReuseSchema = z.object({
  reportType: z.string().trim().min(1).max(200),
  maxAgeSeconds: z.number().int().min(0).max(604800),
  requireFresh: z.boolean().optional(),
}).strict();
export type OutputReuseOptions = z.infer<typeof outputReuseSchema>;

// Hash metadata only, never credential values. Any local connection/secret or
// membership change invalidates prior results, even if the user ID is unchanged.
export async function buildOutputReuseKey(
  ctx: AuthorizeApiSuccess,
  dispatch: ResolvedDispatch,
  message: string,
  reportType: string,
): Promise<string> {
  const { rows } = await db.query<{ scope: { member: unknown } }>(`
    SELECT jsonb_build_object(
      'providers', (SELECT jsonb_agg(jsonb_build_array(provider, updated_at, enabled) ORDER BY provider)
        FROM workspace_native_mcp_provider WHERE workspace_id = $1),
      'member', (SELECT to_jsonb(m) FROM workspace_member m WHERE workspace_id = $1 AND user_id = $2),
      'native', (SELECT jsonb_agg(jsonb_build_array(id, updated_at, status) ORDER BY id)
        FROM workspace_connection WHERE workspace_id = $1 AND user_id = $2),
      'composio', (SELECT jsonb_agg(jsonb_build_array(id, updated_at, status) ORDER BY id)
        FROM workspace_composio_connection WHERE workspace_id = $1 AND user_id = $2),
      'secrets', (SELECT jsonb_agg(jsonb_build_array(id, updated_at) ORDER BY id)
        FROM workspace_secret_connection WHERE workspace_id = $1 AND (user_id = $2 OR user_id IS NULL)),
      'workspaceSecrets', (SELECT jsonb_agg(jsonb_build_array(kind, updated_at) ORDER BY kind)
        FROM workspace_secret WHERE workspace_id = $1),
      'userSecrets', (SELECT jsonb_agg(jsonb_build_array(kind, updated_at) ORDER BY kind)
        FROM workspace_user_secret WHERE workspace_id = $1 AND user_id = $2)
    ) AS scope`, [ctx.workspace.id, ctx.userId]);
  if (!rows[0]?.scope.member) throw new Error("Missing authorization snapshot");
  return createHash("sha256").update(JSON.stringify({
    workspace: ctx.workspace.id, user: ctx.userId, role: ctx.role,
    scopes: [...(ctx.oauthScopes ?? [])].sort(), scope: rows[0].scope,
    reportType, message, agent: dispatch.agentName, path: dispatch.agentPath,
    version: dispatch.versionId, model: dispatch.model, framework: dispatch.framework,
    spec: dispatch.specContent, format: dispatch.specFormat,
    tools: dispatch.toolsModuleContent ?? null,
    skills: Object.entries(dispatch.skillsContent ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  })).digest("hex");
}
