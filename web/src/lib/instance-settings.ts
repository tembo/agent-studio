import "server-only";

import { db } from "@/lib/db";
import { getInstanceNameFromEnv } from "@/lib/config";
import {
  DEFAULT_MAX_CONCURRENT_RUNS,
  DEFAULT_MAX_SUB_AGENTS_PER_ORCHESTRATOR,
} from "@/lib/run-queue";
import {
  isSignupPolicy,
  parseAllowedDomains,
  type SignupPolicy,
  type SignupPolicyConfig,
} from "@/lib/signup-policy";

// Deployment-level settings, backed by the single-row `instance_settings`
// table (migration 0031). Reads fall back to env so an env-configured
// instance keeps working until an admin saves a value. Writes are gated
// to instance admins by the caller (see lib/instance.ts).

export type InstanceSettings = {
  instanceName: string;
};

/**
 * Resolved instance name: DB value if an admin has set one, else the
 * `TAS_INSTANCE_NAME` env fallback. Wrapped in try/catch so build-time
 * / no-DB contexts (and the brief window before migration 0031 runs)
 * degrade to the env value instead of throwing.
 */
export async function getInstanceName(): Promise<string> {
  try {
    const { rows } = await db.query<{ instance_name: string | null }>(
      "SELECT instance_name FROM instance_settings WHERE id = TRUE LIMIT 1",
    );
    const dbName = rows[0]?.instance_name?.trim();
    if (dbName) return dbName;
  } catch {
    // table missing / no DB — fall through to env.
  }
  return getInstanceNameFromEnv();
}

/**
 * The raw stored name (null if unset) — for the settings form, which
 * shows the env fallback as a placeholder rather than prefilling it.
 */
export async function getStoredInstanceName(): Promise<string | null> {
  try {
    const { rows } = await db.query<{ instance_name: string | null }>(
      "SELECT instance_name FROM instance_settings WHERE id = TRUE LIMIT 1",
    );
    return rows[0]?.instance_name?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * When the tool-cache reconcile last completed (null if never / table missing).
 * Used to throttle the boot + scheduled reconcile so restarts don't re-run it
 * within a short window.
 */
export async function getLastToolReconcileAt(): Promise<Date | null> {
  try {
    const { rows } = await db.query<{ last_tool_reconcile_at: Date | null }>(
      "SELECT last_tool_reconcile_at FROM instance_settings WHERE id = TRUE LIMIT 1",
    );
    return rows[0]?.last_tool_reconcile_at ?? null;
  } catch {
    return null;
  }
}

/** Stamp the tool-cache reconcile time (upserts the singleton row). */
export async function markToolReconcile(at: Date): Promise<void> {
  await db.query(
    `INSERT INTO instance_settings (id, last_tool_reconcile_at)
          VALUES (TRUE, $1)
     ON CONFLICT (id) DO UPDATE SET last_tool_reconcile_at = $1`,
    [at],
  );
}

/**
 * First run = no user accounts exist yet. While true, the pre-sign-in
 * setup screen may set the instance name (no admin to gate on yet). On a
 * DB error we return false — fail closed, don't open anonymous setup.
 */
export async function isFirstRun(): Promise<boolean> {
  try {
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "user"`,
    );
    return (rows[0]?.n ?? "0") === "0";
  } catch {
    return false;
  }
}

/** Persist the instance name. Empty string clears it (→ env fallback).
 *  updatedBy is null for the pre-sign-in first-run setup (no user yet). */
export async function setInstanceName(
  name: string,
  updatedBy: string | null,
): Promise<void> {
  const trimmed = name.trim();
  await db.query(
    `UPDATE instance_settings
        SET instance_name = $1, updated_at = now(), updated_by = $2
      WHERE id = TRUE`,
    [trimmed || null, updatedBy],
  );
}

/** Env fallback for the sign-up policy. Hyphens are accepted (`invite-only`)
 *  and folded to the stored snake_case. Unknown / unset → invite_only. */
export function getSignupPolicyFromEnv(): SignupPolicyConfig {
  const raw = process.env.TAS_SIGNUP_POLICY?.trim().toLowerCase().replace(
    /-/g,
    "_",
  );
  return {
    policy: isSignupPolicy(raw) ? raw : "invite_only",
    allowedDomains: parseAllowedDomains(
      process.env.TAS_SIGNUP_ALLOWED_DOMAINS,
    ),
  };
}

/** Raw stored policy. `null` policy means unset (use env). The whole
 *  result is `null` when the table/columns can't be read. */
export async function getStoredSignupPolicy(): Promise<{
  policy: SignupPolicy | null;
  allowedDomains: string[];
} | null> {
  try {
    const { rows } = await db.query<{
      signup_policy: string | null;
      signup_allowed_domains: string[] | null;
    }>(
      `SELECT signup_policy, signup_allowed_domains
         FROM instance_settings WHERE id = TRUE LIMIT 1`,
    );
    const row = rows[0];
    return {
      policy: isSignupPolicy(row?.signup_policy) ? row.signup_policy : null,
      allowedDomains: parseAllowedDomains(row?.signup_allowed_domains),
    };
  } catch {
    return null;
  }
}

/** Resolved policy: DB value if an admin has set one, else env, else
 *  invite-only. A missing table / query failure fails closed (invite-only)
 *  and does not consult env, so a pre-migration window never opens the
 *  instance even if `TAS_SIGNUP_POLICY=open`. */
export async function getSignupPolicy(): Promise<SignupPolicyConfig> {
  const stored = await getStoredSignupPolicy();
  if (!stored) {
    return { policy: "invite_only", allowedDomains: [] };
  }
  if (stored.policy) {
    return {
      policy: stored.policy,
      allowedDomains: stored.allowedDomains,
    };
  }
  return getSignupPolicyFromEnv();
}

/** Persist the sign-up policy. `allowedDomains` is stored even when the
 *  policy isn't domain_allowlist so toggling back keeps the list. */
export async function setSignupPolicy(
  policy: SignupPolicy,
  allowedDomains: string[],
  updatedBy: string,
): Promise<void> {
  await db.query(
    `UPDATE instance_settings
        SET signup_policy = $1,
            signup_allowed_domains = $2,
            updated_at = now(),
            updated_by = $3
      WHERE id = TRUE`,
    [policy, allowedDomains, updatedBy],
  );
}

export type RunQueueSettings = {
  maxConcurrentRuns: number;
  maxSubAgentsPerOrchestrator: number;
};

function parsePositiveInt(raw: string | undefined): number | null {
  const n = Number.parseInt(raw?.trim() ?? "", 10);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

export function getRunQueueSettingsFromEnv(): RunQueueSettings {
  return {
    maxConcurrentRuns:
      parsePositiveInt(process.env.API_MAX_CONCURRENT_RUNS) ??
      DEFAULT_MAX_CONCURRENT_RUNS,
    maxSubAgentsPerOrchestrator:
      parsePositiveInt(process.env.API_MAX_CONCURRENT_SUB_AGENTS_PER_ORCHESTRATOR) ??
      DEFAULT_MAX_SUB_AGENTS_PER_ORCHESTRATOR,
  };
}

export async function getStoredRunQueueSettings(): Promise<{
  maxConcurrentRuns: number | null;
  maxSubAgentsPerOrchestrator: number | null;
} | null> {
  try {
    const { rows } = await db.query<{
      max_concurrent_runs: number | null;
      max_sub_agents_per_orchestrator: number | null;
    }>(
      `SELECT max_concurrent_runs, max_sub_agents_per_orchestrator
         FROM instance_settings WHERE id = TRUE LIMIT 1`,
    );
    const row = rows[0];
    return {
      maxConcurrentRuns:
        row?.max_concurrent_runs && row.max_concurrent_runs >= 1
          ? row.max_concurrent_runs
          : null,
      maxSubAgentsPerOrchestrator:
        row?.max_sub_agents_per_orchestrator &&
        row.max_sub_agents_per_orchestrator >= 1
          ? row.max_sub_agents_per_orchestrator
          : null,
    };
  } catch {
    return null;
  }
}

/** Resolved run-queue limits: DB if an admin has saved, else env, else defaults. */
export async function getRunQueueSettings(): Promise<RunQueueSettings> {
  const stored = await getStoredRunQueueSettings();
  const env = getRunQueueSettingsFromEnv();
  return {
    maxConcurrentRuns: stored?.maxConcurrentRuns ?? env.maxConcurrentRuns,
    maxSubAgentsPerOrchestrator:
      stored?.maxSubAgentsPerOrchestrator ?? env.maxSubAgentsPerOrchestrator,
  };
}

export async function setRunQueueSettings(
  settings: RunQueueSettings,
  updatedBy: string,
): Promise<void> {
  await db.query(
    `UPDATE instance_settings
        SET max_concurrent_runs = $1,
            max_sub_agents_per_orchestrator = $2,
            updated_at = now(),
            updated_by = $3
      WHERE id = TRUE`,
    [
      settings.maxConcurrentRuns,
      settings.maxSubAgentsPerOrchestrator,
      updatedBy,
    ],
  );
}
