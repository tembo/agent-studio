import "server-only";

import { getServerSession } from "@/lib/session";

// Instance-admin policy. Admins come from two places: the
// INSTANCE_ADMIN_EMAILS env allowlist (bootstraps a fresh deployment)
// and the `instance_admin` table (added in-app from Instance settings —
// see lib/instance-admins). `isInstanceAdmin` checks the union.
//
// The pure env checks live in lib/config and the DB-aware ones in
// lib/instance-admins (no session deps) so the sign-up gate in lib/auth
// can use them without a cycle. Re-exported here so
// callers have one import for instance-admin logic. `authorizeInstance`
// adds the session-aware gate, mirroring lib/auth-server.ts
// `authorizeWorkspace`.
export { getInstanceAdminEmails, isInstanceAdminEmail } from "@/lib/config";
export { isInstanceAdmin } from "@/lib/instance-admins";
import { isInstanceAdmin } from "@/lib/instance-admins";

export type AuthorizeInstanceResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; reason: "no-session" | "denied" };

/**
 * Gate for instance-scoped (deployment-level) routes and actions.
 * Returns a discriminated union rather than throwing, matching
 * `authorizeWorkspace`. A denied non-admin is the caller's cue to
 * redirect away (don't leak the admin surface).
 */
export async function authorizeInstance(): Promise<AuthorizeInstanceResult> {
  const session = await getServerSession();
  if (!session) return { ok: false, reason: "no-session" };
  if (!(await isInstanceAdmin(session.user.email))) {
    return { ok: false, reason: "denied" };
  }
  return { ok: true, userId: session.user.id, email: session.user.email };
}
