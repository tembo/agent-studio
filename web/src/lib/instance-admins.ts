import "server-only";

import { getInstanceAdminEmails, isInstanceAdminEmail } from "@/lib/config";
import { db } from "@/lib/db";

// DB-backed instance admins, unioned with the INSTANCE_ADMIN_EMAILS env
// allowlist (lib/config). The env list bootstraps the first admin on a
// fresh deployment; the `instance_admin` table (migration 0069) lets that
// admin hand the instance to others in-app (Instance settings) without
// touching deploy env. Kept session-free so the sign-up gate in lib/auth
// can call isInstanceAdmin without a cycle through
// lib/session → lib/auth.

export type InstanceAdmin = {
  email: string;
  /** "env" = from INSTANCE_ADMIN_EMAILS (not removable in-app). */
  source: "env" | "db";
  addedByName: string | null;
  createdAt: Date | null;
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Env ∪ DB admin check. DB errors (no DB at build time, or the brief
 * window before migration 0069 applies) degrade to the env answer
 * rather than throwing — mirrors lib/instance-settings.
 */
export async function isInstanceAdmin(
  email: string | null | undefined,
): Promise<boolean> {
  if (!email) return false;
  if (isInstanceAdminEmail(email)) return true;
  try {
    const { rowCount } = await db.query(
      `SELECT 1 FROM instance_admin WHERE email = lower($1) LIMIT 1`,
      [email.trim()],
    );
    return (rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Env admins first (deploy-controlled), then in-app ones by add date. */
export async function listInstanceAdmins(): Promise<InstanceAdmin[]> {
  const envEmails = getInstanceAdminEmails();
  let dbRows: {
    email: string;
    added_by_name: string | null;
    created_at: Date;
  }[] = [];
  try {
    const { rows } = await db.query<{
      email: string;
      added_by_name: string | null;
      created_at: Date;
    }>(
      `SELECT a.email, u.name AS added_by_name, a.created_at
         FROM instance_admin a
         LEFT JOIN "user" u ON u.id = a.added_by
        ORDER BY a.created_at ASC`,
    );
    dbRows = rows;
  } catch {
    // table missing / no DB — show env admins only.
  }
  return [
    ...envEmails.map<InstanceAdmin>((email) => ({
      email,
      source: "env",
      addedByName: null,
      createdAt: null,
    })),
    // An email in both places renders once, as env (the stronger claim —
    // it survives a DB-side removal).
    ...dbRows
      .filter((r) => !envEmails.includes(r.email))
      .map<InstanceAdmin>((r) => ({
        email: r.email,
        source: "db",
        addedByName: r.added_by_name,
        createdAt: r.created_at,
      })),
  ];
}

export type AddInstanceAdminResult =
  | { ok: true; email: string }
  | { ok: false; error: "bad-email" | "already-admin" };

export async function addInstanceAdmin(
  emailRaw: string,
  addedBy: string,
): Promise<AddInstanceAdminResult> {
  const email = emailRaw.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: "bad-email" };
  if (isInstanceAdminEmail(email)) return { ok: false, error: "already-admin" };
  const res = await db.query(
    `INSERT INTO instance_admin (email, added_by)
     VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING`,
    [email, addedBy],
  );
  if ((res.rowCount ?? 0) === 0) return { ok: false, error: "already-admin" };
  return { ok: true, email };
}

/** Remove an in-app admin. Env-listed admins are untouchable here —
 *  the row (if any) may go, but the env grant stands. Returns whether
 *  a row was deleted. */
export async function removeInstanceAdmin(emailRaw: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `DELETE FROM instance_admin WHERE email = lower($1)`,
    [emailRaw.trim()],
  );
  return (rowCount ?? 0) > 0;
}
