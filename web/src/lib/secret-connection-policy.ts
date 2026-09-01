import type { WorkspaceRole } from "@/lib/rbac";
import type { SecretConnectionScope } from "@/lib/secret-connections";

export function canCreateSecretScope(
  role: WorkspaceRole,
  scope: SecretConnectionScope,
): boolean {
  if (scope === "workspace") return role === "workspace_admin";
  return role === "operator" || role === "workspace_admin";
}

export function canManageSecretScope(
  role: WorkspaceRole,
  scope: SecretConnectionScope,
): boolean {
  return canCreateSecretScope(role, scope);
}
