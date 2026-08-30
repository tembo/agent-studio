import "server-only";

import { decryptSecret, encryptSecret, last4 } from "@/lib/crypto";
import { aadWorkspaceSecret } from "@/lib/crypto-aad";
import { db } from "@/lib/db";
import {
  parseRepoInput,
  validateRepo,
  type ValidateRepoError,
} from "@/lib/github";
import { isWorkspaceRole, type WorkspaceRole } from "@/lib/rbac";
import { suggestSlug, validateSlug } from "@/lib/slugify";

export type WorkspaceSecretKind =
  | "tembo_api_key"
  | "github_pat"
  | "anthropic_api_key"
  | "openai_api_key"
  | "scaledown_api_key"
  | "composio_api_key"
  | "composio_webhook_secret";

// Single source of truth lives in @/lib/favicon-constants (client-safe).
// Re-exported here so server-side callers don't need to know.
export {
  FAVICON_KINDS,
  DEFAULT_FAVICON_KINDS,
  FAVICON_LABELS,
} from "@/lib/favicon-constants";
export type { FaviconKind } from "@/lib/favicon-constants";

import type { FaviconKind } from "@/lib/favicon-constants";

// Re-exported so server callers don't reach into the client-safe module.
export { COMMIT_MODES, COMMIT_MODE_LABELS } from "@/lib/commit-mode-constants";
export type { CommitMode } from "@/lib/commit-mode-constants";

import type { CommitMode } from "@/lib/commit-mode-constants";

export type Workspace = {
  id: string;
  name: string;
  slug: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  faviconKind: FaviconKind;
  // How the Tembo Coding Agent's changes land: PR (default) or direct commit.
  commitMode: CommitMode;
};

function rowToWorkspace(row: {
  id: string;
  name: string;
  slug: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  favicon_kind: FaviconKind;
  commit_mode: CommitMode;
}): Workspace {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    faviconKind: row.favicon_kind,
    commitMode: row.commit_mode,
  };
}

type WorkspaceRow = {
  id: string;
  name: string;
  slug: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  favicon_kind: FaviconKind;
  commit_mode: CommitMode;
};

const WORKSPACE_COLUMNS =
  "id, name, slug, created_by, created_at, updated_at, favicon_kind, commit_mode";

export async function listWorkspacesForUser(userId: string): Promise<Workspace[]> {
  // Order by recency-of-last-visit so the "/" redirect lands on
  // wherever the user was last. NULLS LAST keeps never-visited
  // workspaces below visited ones; ties fall back to creation order
  // for stability.
  const { rows } = await db.query<WorkspaceRow>(
    `SELECT w.id, w.name, w.slug, w.created_by, w.created_at, w.updated_at, w.favicon_kind
       FROM workspace w
       JOIN workspace_member m ON m.workspace_id = w.id
      WHERE m.user_id = $1
      ORDER BY m.last_visited_at DESC NULLS LAST, w.created_at ASC`,
    [userId],
  );
  return rows.map(rowToWorkspace);
}

/**
 * Bump the (workspace_id, user_id) row's last_visited_at to NOW().
 * Fire-and-forget — called from the workspace layout on every
 * request, but failures here mustn't break page rendering. Safe to
 * race; the row update is atomic.
 */
export async function touchWorkspaceLastVisited(
  workspaceId: string,
  userId: string,
): Promise<void> {
  try {
    await db.query(
      `UPDATE workspace_member
          SET last_visited_at = NOW()
        WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId],
    );
  } catch {
    // Non-fatal: the row stays stale until the next successful visit.
  }
}

export async function getWorkspaceBySlug(
  slug: string,
): Promise<Workspace | null> {
  const { rows } = await db.query<WorkspaceRow>(
    `SELECT ${WORKSPACE_COLUMNS}
       FROM workspace
      WHERE slug = $1
      LIMIT 1`,
    [slug],
  );
  return rows[0] ? rowToWorkspace(rows[0]) : null;
}

/**
 * Look up a workspace by its UUID. Unlike getWorkspaceBySlug, this is
 * the entry point for callers that already hold an id — notably
 * authorizeApiRequest, which resolves the workspace from an API key's
 * stored workspace_id rather than a URL slug.
 */
export async function getWorkspaceById(
  id: string,
): Promise<Workspace | null> {
  const { rows } = await db.query<WorkspaceRow>(
    `SELECT ${WORKSPACE_COLUMNS}
       FROM workspace
      WHERE id = $1
      LIMIT 1`,
    [id],
  );
  return rows[0] ? rowToWorkspace(rows[0]) : null;
}

export type WorkspaceMember = {
  userId: string;
  name: string | null;
  email: string;
  role: WorkspaceRole;
  joinedAt: Date;
};

/**
 * List every member of a workspace with their role + joined-at.
 * Used by the Settings → Members section and (without the role
 * field, historically) the automation "Run as" picker.
 */
export async function listWorkspaceMembers(
  workspaceId: string,
): Promise<WorkspaceMember[]> {
  const { rows } = await db.query<{
    user_id: string;
    name: string | null;
    email: string;
    role: string;
    joined_at: Date;
  }>(
    `SELECT m.user_id, u.name, u.email, m.role, m.joined_at
       FROM workspace_member m
       JOIN "user" u ON u.id = m.user_id
      WHERE m.workspace_id = $1
      ORDER BY COALESCE(u.name, u.email) ASC`,
    [workspaceId],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    email: r.email,
    role: isWorkspaceRole(r.role) ? r.role : "viewer",
    joinedAt: r.joined_at,
  }));
}

export type AddMemberError = "user-not-found" | "already-member";
export type AddMemberResult =
  | { ok: true; member: WorkspaceMember }
  | { ok: false; error: AddMemberError };

/**
 * Add a user to a workspace at the given role. Looks the user up by
 * email (case-insensitive). Returns 'user-not-found' if no user row
 * has signed in with that email yet — the inviter needs to ask the
 * person to sign in once first, then re-try. Returns 'already-member'
 * when the row already exists; we never silently overwrite a role
 * via this path (use changeMemberRole for that).
 */
export async function addWorkspaceMemberByEmail(
  workspaceId: string,
  email: string,
  role: WorkspaceRole,
): Promise<AddMemberResult> {
  const normalized = email.trim().toLowerCase();
  const { rows: userRows } = await db.query<{
    id: string;
    name: string | null;
    email: string;
  }>(
    `SELECT id, name, email FROM "user" WHERE LOWER(email) = $1 LIMIT 1`,
    [normalized],
  );
  const user = userRows[0];
  if (!user) return { ok: false, error: "user-not-found" };

  const insert = await db.query(
    `INSERT INTO workspace_member (workspace_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, user_id) DO NOTHING
     RETURNING joined_at`,
    [workspaceId, user.id, role],
  );
  if ((insert.rowCount ?? 0) === 0) {
    return { ok: false, error: "already-member" };
  }
  return {
    ok: true,
    member: {
      userId: user.id,
      name: user.name,
      email: user.email,
      role,
      joinedAt: (insert.rows[0] as { joined_at: Date }).joined_at,
    },
  };
}

export type ChangeMemberRoleError = "not-found" | "last-admin";
export type ChangeMemberRoleResult =
  | {
      ok: true;
      previousRole: WorkspaceRole;
      newRole: WorkspaceRole;
      /** Target user display details — used by audit payloads. */
      target: { name: string | null; email: string };
    }
  | { ok: false; error: ChangeMemberRoleError };

/**
 * Change a member's role. Blocks self-demotion of the last
 * workspace_admin — an unreachable workspace is worse than a
 * permission-denied error. Returns the previous role so the audit
 * log can render a meaningful diff.
 */
export async function changeMemberRole(
  workspaceId: string,
  targetUserId: string,
  newRole: WorkspaceRole,
): Promise<ChangeMemberRoleResult> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: existingRows } = await client.query<{
      role: string;
      name: string | null;
      email: string;
    }>(
      `SELECT m.role, u.name, u.email
         FROM workspace_member m
         JOIN "user" u ON u.id = m.user_id
        WHERE m.workspace_id = $1 AND m.user_id = $2
        FOR UPDATE OF m`,
      [workspaceId, targetUserId],
    );
    const existing = existingRows[0];
    if (!existing) {
      await client.query("ROLLBACK");
      return { ok: false, error: "not-found" };
    }
    const previousRole = isWorkspaceRole(existing.role)
      ? existing.role
      : "viewer";
    const target = { name: existing.name, email: existing.email };
    if (previousRole === newRole) {
      await client.query("ROLLBACK");
      return { ok: true, previousRole, newRole, target };
    }
    // Block last-admin demotion: count admins, refuse if this
    // member is the only one and they're being demoted.
    if (previousRole === "workspace_admin" && newRole !== "workspace_admin") {
      const { rows: countRows } = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n
           FROM workspace_member
          WHERE workspace_id = $1 AND role = 'workspace_admin'`,
        [workspaceId],
      );
      if (Number(countRows[0].n) <= 1) {
        await client.query("ROLLBACK");
        return { ok: false, error: "last-admin" };
      }
    }
    await client.query(
      `UPDATE workspace_member SET role = $3
        WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, targetUserId, newRole],
    );
    await client.query("COMMIT");
    return { ok: true, previousRole, newRole, target };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function userIsMember(
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM workspace_member WHERE workspace_id = $1 AND user_id = $2 LIMIT 1`,
    [workspaceId, userId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Returns the user's workspace role, or null if they aren't a member.
 * This is the only path through which role is read — server actions
 * pair it with meetsMinRole / requireWorkspaceRole from @/lib/rbac.
 */
export async function getWorkspaceRole(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  const { rows } = await db.query<{ role: string }>(
    `SELECT role FROM workspace_member
      WHERE workspace_id = $1 AND user_id = $2
      LIMIT 1`,
    [workspaceId, userId],
  );
  const role = rows[0]?.role;
  if (!role) return null;
  // Defensive guard: the CHECK constraint should keep junk out, but
  // returning null on an unrecognized value beats throwing during a
  // hot request path.
  return isWorkspaceRole(role) ? role : null;
}

/**
 * Permanently delete a workspace and everything scoped to it. Every
 * workspace-scoped table FKs to workspace(id) ON DELETE CASCADE, so one
 * DELETE removes members, secrets, repo, runs, agent-deletion records,
 * connections, automations, improvements, audit, and invitations. The
 * exception is workspace_trigger, whose connection_id is ON DELETE
 * RESTRICT to workspace_composio_connection — left to the cascade's
 * ordering that RESTRICT could abort the delete, so we remove triggers
 * explicitly first, in the same transaction. Does NOT touch the GitHub
 * repo — agent specs live there and are untouched.
 */
export async function deleteWorkspace(workspaceId: string): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM workspace_trigger WHERE workspace_id = $1`, [
      workspaceId,
    ]);
    await client.query(`DELETE FROM workspace WHERE id = $1`, [workspaceId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export type CreateWorkspaceResult =
  | { ok: true; workspace: Workspace }
  | { ok: false; error: CreateWorkspaceError };

export type CreateWorkspaceError =
  | "name-required"
  | "slug-too-short"
  | "slug-too-long"
  | "slug-invalid-chars"
  | "slug-reserved"
  | "slug-taken";

/**
 * Create a workspace and add `userId` as its admin member, atomically.
 * Slug is auto-derived from the name when not provided.
 */
export async function createWorkspace(
  userId: string,
  input: { name: string; slug?: string },
): Promise<CreateWorkspaceResult> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "name-required" };

  const slug = (input.slug ?? suggestSlug(name)).trim();
  const slugError = validateSlug(slug);
  if (slugError) {
    return {
      ok: false,
      error: (`slug-${slugError}` as CreateWorkspaceError),
    };
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Pre-check for taken slug to surface a clean error code instead of
    // a unique-violation exception bubble.
    const existing = await client.query(
      `SELECT 1 FROM workspace WHERE slug = $1 LIMIT 1`,
      [slug],
    );
    if ((existing.rowCount ?? 0) > 0) {
      await client.query("ROLLBACK");
      return { ok: false, error: "slug-taken" };
    }

    const { rows } = await client.query<WorkspaceRow>(
      `INSERT INTO workspace (name, slug, created_by)
       VALUES ($1, $2, $3)
       RETURNING ${WORKSPACE_COLUMNS}`,
      [name, slug, userId],
    );
    const workspace = rowToWorkspace(rows[0]);

    await client.query(
      `INSERT INTO workspace_member (workspace_id, user_id, role)
       VALUES ($1, $2, 'workspace_admin')`,
      [workspace.id, userId],
    );

    await client.query("COMMIT");
    return { ok: true, workspace };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ── Rename + slug aliases ────────────────────────────────────────────────

export type RenameWorkspaceError =
  | "name-required"
  | "slug-too-short"
  | "slug-too-long"
  | "slug-invalid-chars"
  | "slug-reserved"
  | "slug-taken";

export type RenameWorkspaceResult =
  | { ok: true; workspace: Workspace; slugChanged: boolean }
  | { ok: false; error: RenameWorkspaceError };

/**
 * Rename a workspace (GitHub-org style: the URL slug is re-derived from the
 * new name). When the slug changes, the previous slug is recorded in
 * `workspace_slug_alias` so old links keep resolving, and any alias that
 * equals the new slug for THIS workspace is reclaimed. A new slug that's a
 * live slug or another workspace's alias is rejected as taken.
 */
export async function renameWorkspace(
  workspaceId: string,
  currentSlug: string,
  rawName: string,
): Promise<RenameWorkspaceResult> {
  const name = rawName.trim();
  if (!name) return { ok: false, error: "name-required" };

  const slug = suggestSlug(name).trim();
  const slugError = validateSlug(slug);
  if (slugError) {
    return { ok: false, error: `slug-${slugError}` as RenameWorkspaceError };
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const slugChanged = slug !== currentSlug;

    if (slugChanged) {
      // Reject if the new slug is a live slug on another workspace…
      const liveClash = await client.query(
        `SELECT 1 FROM workspace WHERE slug = $1 AND id <> $2 LIMIT 1`,
        [slug, workspaceId],
      );
      if ((liveClash.rowCount ?? 0) > 0) {
        await client.query("ROLLBACK");
        return { ok: false, error: "slug-taken" };
      }
      // …or an old slug pointing at a different workspace. If it's one of
      // ours (the workspace is reverting to an earlier name), reclaim it.
      const aliasOwner = await client.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM workspace_slug_alias WHERE old_slug = $1 LIMIT 1`,
        [slug],
      );
      if (aliasOwner.rows[0] && aliasOwner.rows[0].workspace_id !== workspaceId) {
        await client.query("ROLLBACK");
        return { ok: false, error: "slug-taken" };
      }
      await client.query(
        `DELETE FROM workspace_slug_alias WHERE old_slug = $1`,
        [slug],
      );
      // Keep the slug we're leaving as an alias for this workspace.
      await client.query(
        `INSERT INTO workspace_slug_alias (old_slug, workspace_id)
         VALUES ($1, $2)
         ON CONFLICT (old_slug)
           DO UPDATE SET workspace_id = EXCLUDED.workspace_id, created_at = NOW()`,
        [currentSlug, workspaceId],
      );
    }

    const { rows } = await client.query<WorkspaceRow>(
      `UPDATE workspace
          SET name = $1, slug = $2, updated_at = NOW()
        WHERE id = $3
        RETURNING ${WORKSPACE_COLUMNS}`,
      [name, slug, workspaceId],
    );

    await client.query("COMMIT");
    return { ok: true, workspace: rowToWorkspace(rows[0]), slugChanged };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Resolve a possibly-stale slug to the workspace's current slug via the
 * alias table. Returns null when the slug was never a workspace's slug.
 * Only called on the slug-miss path, so the live-slug hot path pays nothing.
 */
export async function resolveWorkspaceSlugAlias(
  oldSlug: string,
): Promise<string | null> {
  const { rows } = await db.query<{ slug: string }>(
    `SELECT w.slug
       FROM workspace_slug_alias a
       JOIN workspace w ON w.id = a.workspace_id
      WHERE a.old_slug = $1
      LIMIT 1`,
    [oldSlug],
  );
  return rows[0]?.slug ?? null;
}

// ── Workspace favicon ────────────────────────────────────────────────────

const FAVICON_ALLOWED_MIMES = new Set([
  "image/png",
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);
const FAVICON_MAX_BYTES = 200 * 1024;

export type SetFaviconError =
  | "no-workspace"
  | "empty"
  | "too-large"
  | "unsupported-mime";

export type SetFaviconResult =
  | { ok: true; kind: FaviconKind }
  | { ok: false; error: SetFaviconError };

export async function setFaviconDefault(
  workspaceId: string,
  kind: Exclude<FaviconKind, "custom">,
): Promise<SetFaviconResult> {
  // Clearing blob+mime keeps `custom` data from lingering after switching
  // away from it.
  const { rowCount } = await db.query(
    `UPDATE workspace
        SET favicon_kind = $2,
            favicon_blob = NULL,
            favicon_mime = NULL,
            updated_at = NOW()
      WHERE id = $1`,
    [workspaceId, kind],
  );
  if (!rowCount) return { ok: false, error: "no-workspace" };
  return { ok: true, kind };
}

export async function setFaviconCustom(
  workspaceId: string,
  args: { bytes: Buffer; mime: string },
): Promise<SetFaviconResult> {
  if (args.bytes.length === 0) return { ok: false, error: "empty" };
  if (args.bytes.length > FAVICON_MAX_BYTES) {
    return { ok: false, error: "too-large" };
  }
  if (!FAVICON_ALLOWED_MIMES.has(args.mime)) {
    return { ok: false, error: "unsupported-mime" };
  }
  const { rowCount } = await db.query(
    `UPDATE workspace
        SET favicon_kind = 'custom',
            favicon_blob = $2,
            favicon_mime = $3,
            updated_at = NOW()
      WHERE id = $1`,
    [workspaceId, args.bytes, args.mime],
  );
  if (!rowCount) return { ok: false, error: "no-workspace" };
  return { ok: true, kind: "custom" };
}

/**
 * Returns the custom favicon bytes + mime if `favicon_kind = 'custom'`,
 * otherwise null (the caller redirects to the static default).
 */
export async function getCustomFaviconBytes(
  workspaceId: string,
): Promise<{ bytes: Buffer; mime: string } | null> {
  const { rows } = await db.query<{
    favicon_kind: FaviconKind;
    favicon_blob: Buffer | null;
    favicon_mime: string | null;
  }>(
    `SELECT favicon_kind, favicon_blob, favicon_mime
       FROM workspace WHERE id = $1`,
    [workspaceId],
  );
  const row = rows[0];
  if (!row || row.favicon_kind !== "custom") return null;
  if (!row.favicon_blob || !row.favicon_mime) return null;
  return { bytes: row.favicon_blob, mime: row.favicon_mime };
}

// ── Workspace secrets ────────────────────────────────────────────────────

export type WorkspaceSecretPreview = {
  last4: string;
  updatedAt: Date;
};

export async function getWorkspaceSecretPreview(
  workspaceId: string,
  kind: WorkspaceSecretKind,
): Promise<WorkspaceSecretPreview | null> {
  const { rows } = await db.query<{ last4: string; updated_at: Date }>(
    `SELECT last4, updated_at
       FROM workspace_secret
      WHERE workspace_id = $1 AND kind = $2`,
    [workspaceId, kind],
  );
  if (!rows[0]) return null;
  return { last4: rows[0].last4, updatedAt: rows[0].updated_at };
}

/**
 * Returns the decrypted secret. Runtime use only — never serialize to a
 * client. Throws if the secret does not exist for (workspace, kind).
 */
export async function getWorkspaceSecretPlaintext(
  workspaceId: string,
  kind: WorkspaceSecretKind,
): Promise<string> {
  const { rows } = await db.query<{ ciphertext: Buffer }>(
    `SELECT ciphertext FROM workspace_secret WHERE workspace_id = $1 AND kind = $2`,
    [workspaceId, kind],
  );
  if (!rows[0]) {
    throw new Error(`workspace secret not found: ${kind}`);
  }
  return decryptSecret(rows[0].ciphertext, aadWorkspaceSecret(workspaceId, kind));
}

// ── Commit mode (PR vs direct / YOLO) ────────────────────────────────────

export async function setWorkspaceCommitMode(
  workspaceId: string,
  mode: CommitMode,
): Promise<{ ok: true } | { ok: false; error: "no-workspace" }> {
  const { rowCount } = await db.query(
    `UPDATE workspace SET commit_mode = $2, updated_at = NOW() WHERE id = $1`,
    [workspaceId, mode],
  );
  if (!rowCount) return { ok: false, error: "no-workspace" };
  return { ok: true };
}

export type SetWorkspaceSecretError =
  | "empty"
  | "too-short"
  | "too-long"
  | "bad-prefix";

export type SetWorkspaceSecretResult =
  | { ok: true }
  | { ok: false; error: SetWorkspaceSecretError };

// Per-provider prefix sniffs. Cheap shape check that catches the
// most common misclick (pasting an error page or unrelated text
// into the form). We never reject on prefix mismatch alone for
// providers we don't have a known prefix for — the rates change
// across plans/SKUs and locking that down would create more
// false-negative pain than it prevents.
const SECRET_PREFIXES: Partial<Record<WorkspaceSecretKind, string[]>> = {
  composio_api_key: ["ak_"],
  anthropic_api_key: ["sk-ant-"],
  openai_api_key: ["sk-"],
};

export async function setWorkspaceSecret(
  workspaceId: string,
  kind: WorkspaceSecretKind,
  plaintext: string,
): Promise<SetWorkspaceSecretResult> {
  const trimmed = plaintext.trim();
  if (trimmed.length === 0) return { ok: false, error: "empty" };
  // Conservative shape checks — keep the application from storing junk while
  // still tolerating whatever format Tembo issues today vs tomorrow.
  if (trimmed.length < 16) return { ok: false, error: "too-short" };
  if (trimmed.length > 512) return { ok: false, error: "too-long" };
  const expectedPrefixes = SECRET_PREFIXES[kind];
  if (
    expectedPrefixes &&
    !expectedPrefixes.some((p) => trimmed.startsWith(p))
  ) {
    return { ok: false, error: "bad-prefix" };
  }

  const ciphertext = encryptSecret(trimmed, aadWorkspaceSecret(workspaceId, kind));
  await db.query(
    `INSERT INTO workspace_secret (workspace_id, kind, ciphertext, last4)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, kind)
       DO UPDATE SET ciphertext = EXCLUDED.ciphertext,
                     last4 = EXCLUDED.last4,
                     updated_at = NOW()`,
    [workspaceId, kind, ciphertext, last4(trimmed)],
  );
  return { ok: true };
}

export async function removeWorkspaceSecret(
  workspaceId: string,
  kind: WorkspaceSecretKind,
): Promise<void> {
  await db.query(
    `DELETE FROM workspace_secret WHERE workspace_id = $1 AND kind = $2`,
    [workspaceId, kind],
  );
}

// ── Workspace Git repo ───────────────────────────────────────────────────

export type WorkspaceRepo = {
  workspaceId: string;
  provider: "github";
  owner: string;
  name: string;
  defaultBranch: string;
  connectedAt: Date;
  connectedBy: string;
};

export async function getWorkspaceRepo(
  workspaceId: string,
): Promise<WorkspaceRepo | null> {
  const { rows } = await db.query<{
    workspace_id: string;
    provider: "github";
    owner: string;
    name: string;
    default_branch: string;
    connected_at: Date;
    connected_by: string;
  }>(
    `SELECT workspace_id, provider, owner, name, default_branch, connected_at, connected_by
       FROM workspace_repo
      WHERE workspace_id = $1`,
    [workspaceId],
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    workspaceId: r.workspace_id,
    provider: r.provider,
    owner: r.owner,
    name: r.name,
    defaultBranch: r.default_branch,
    connectedAt: r.connected_at,
    connectedBy: r.connected_by,
  };
}

export type ConnectWorkspaceRepoError =
  | "unparseable-repo"
  | "missing-token"
  | ValidateRepoError;

export type ConnectWorkspaceRepoResult =
  | { ok: true; repo: WorkspaceRepo }
  | { ok: false; error: ConnectWorkspaceRepoError; detail?: string };

/**
 * Validate the PAT can read+write the repo (via GitHub API), then store
 * both the encrypted PAT and the resolved repo metadata atomically.
 * Replaces any prior repo connection on the workspace.
 */
export async function connectWorkspaceRepo(
  workspaceId: string,
  userId: string,
  input: { repo: string; token: string },
): Promise<ConnectWorkspaceRepoResult> {
  const token = input.token.trim();
  if (!token) return { ok: false, error: "missing-token" };

  const parsed = parseRepoInput(input.repo);
  if (!parsed) return { ok: false, error: "unparseable-repo" };

  const validation = await validateRepo(token, parsed);
  if (!validation.ok) {
    return { ok: false, error: validation.error, detail: validation.detail };
  }

  const ciphertext = encryptSecret(token, aadWorkspaceSecret(workspaceId, "github_pat"));
  const tokenLast4 = last4(token);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO workspace_secret (workspace_id, kind, ciphertext, last4)
         VALUES ($1, 'github_pat', $2, $3)
         ON CONFLICT (workspace_id, kind)
         DO UPDATE SET ciphertext = EXCLUDED.ciphertext,
                       last4 = EXCLUDED.last4,
                       updated_at = NOW()`,
      [workspaceId, ciphertext, tokenLast4],
    );
    await client.query(
      `INSERT INTO workspace_repo
         (workspace_id, provider, owner, name, default_branch, connected_by)
         VALUES ($1, 'github', $2, $3, $4, $5)
         ON CONFLICT (workspace_id)
         DO UPDATE SET provider = EXCLUDED.provider,
                       owner = EXCLUDED.owner,
                       name = EXCLUDED.name,
                       default_branch = EXCLUDED.default_branch,
                       connected_by = EXCLUDED.connected_by,
                       connected_at = NOW()`,
      [workspaceId, validation.owner, validation.name, validation.defaultBranch, userId],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const repo = await getWorkspaceRepo(workspaceId);
  if (!repo) throw new Error("workspace_repo disappeared after insert");
  return { ok: true, repo };
}

/**
 * Disconnect the repo: drops both the row and the encrypted PAT.
 */
export async function disconnectWorkspaceRepo(
  workspaceId: string,
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM workspace_repo WHERE workspace_id = $1`,
      [workspaceId],
    );
    await client.query(
      `DELETE FROM workspace_secret WHERE workspace_id = $1 AND kind = 'github_pat'`,
      [workspaceId],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
