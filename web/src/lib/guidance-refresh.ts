import "server-only";

import { writeAuditEvent } from "@/lib/audit-db";
import type { AuditSource } from "@/lib/audit";
import { db } from "@/lib/db";
import { refreshAllGuidanceFiles } from "@/lib/workspace-agents";

export const GUIDANCE_REFRESH_CADENCES = ["off", "daily", "weekly"] as const;
export type GuidanceRefreshCadence =
  (typeof GUIDANCE_REFRESH_CADENCES)[number];

export type GuidanceRefreshSettings = {
  cadence: GuidanceRefreshCadence;
  refreshedAt: Date | null;
};

type GuidanceRefreshRow = {
  id: string;
  guidance_refresh_cadence: GuidanceRefreshCadence;
  guidance_refreshed_at: Date | null;
};

export function isGuidanceRefreshCadence(
  value: string,
): value is GuidanceRefreshCadence {
  return GUIDANCE_REFRESH_CADENCES.includes(value as GuidanceRefreshCadence);
}

export async function getGuidanceRefreshSettings(
  workspaceId: string,
): Promise<GuidanceRefreshSettings> {
  const { rows } = await db.query<GuidanceRefreshRow>(
    `SELECT id, guidance_refresh_cadence, guidance_refreshed_at
       FROM workspace
      WHERE id = $1`,
    [workspaceId],
  );
  const row = rows[0];
  return {
    cadence: row?.guidance_refresh_cadence ?? "off",
    refreshedAt: row?.guidance_refreshed_at ?? null,
  };
}

export async function setGuidanceRefreshCadence(
  workspaceId: string,
  cadence: GuidanceRefreshCadence,
): Promise<void> {
  await db.query(
    `UPDATE workspace
        SET guidance_refresh_cadence = $2, updated_at = NOW()
      WHERE id = $1`,
    [workspaceId, cadence],
  );
}

async function markGuidanceRefreshed(
  workspaceId: string,
  at: Date,
  claimedAt?: Date,
): Promise<void> {
  if (claimedAt) {
    await db.query(
      `UPDATE workspace
          SET guidance_refreshed_at = $2,
              guidance_refresh_claimed_at = CASE
                WHEN guidance_refresh_claimed_at = $3 THEN NULL
                ELSE guidance_refresh_claimed_at
              END
        WHERE id = $1`,
      [workspaceId, at, claimedAt],
    );
    return;
  }

  await db.query(
    `UPDATE workspace
        SET guidance_refreshed_at = $2
      WHERE id = $1`,
    [workspaceId, at],
  );
}

export async function refreshWorkspaceGuidance(args: {
  workspaceId: string;
  actorUserId: string | null;
  source: AuditSource;
  trigger: "manual" | "schedule";
  cadence?: Exclude<GuidanceRefreshCadence, "off">;
  at?: Date;
  claimedAt?: Date;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await refreshAllGuidanceFiles(args.workspaceId);
  if (!result.ok) return result;

  const refreshedAt = args.at ?? new Date();
  await markGuidanceRefreshed(args.workspaceId, refreshedAt, args.claimedAt);
  await writeAuditEvent({
    workspaceId: args.workspaceId,
    actorUserId: args.actorUserId,
    source: args.source,
    kind: "guidance.synced",
    targetType: "workspace",
    targetId: null,
    agentName: null,
    payload: {
      trigger: args.trigger,
      ...(args.cadence ? { cadence: args.cadence } : {}),
    },
  });
  return { ok: true };
}

export async function claimDueGuidanceRefreshes(
  now: Date,
): Promise<
  Array<{
    workspaceId: string;
    cadence: Exclude<GuidanceRefreshCadence, "off">;
  }>
> {
  const { rows } = await db.query<GuidanceRefreshRow>(
    `WITH due AS (
       SELECT w.id
         FROM workspace w
         JOIN workspace_repo r ON r.workspace_id = w.id
        WHERE w.guidance_refresh_cadence <> 'off'
          AND (
            w.guidance_refreshed_at IS NULL
            OR w.guidance_refreshed_at < $1::timestamptz - (
              CASE w.guidance_refresh_cadence
                WHEN 'daily' THEN INTERVAL '1 day'
                ELSE INTERVAL '7 days'
              END
            )
          )
          AND (
            w.guidance_refresh_claimed_at IS NULL
            OR w.guidance_refresh_claimed_at < $1::timestamptz - INTERVAL '15 minutes'
          )
        FOR UPDATE OF w SKIP LOCKED
     )
     UPDATE workspace w
        SET guidance_refresh_claimed_at = $1
       FROM due
      WHERE w.id = due.id
      RETURNING w.id, w.guidance_refresh_cadence, w.guidance_refreshed_at`,
    [now],
  );
  return rows.map((row) => ({
    workspaceId: row.id,
    cadence: row.guidance_refresh_cadence as Exclude<
      GuidanceRefreshCadence,
      "off"
    >,
  }));
}

export async function runDueGuidanceRefreshes(now = new Date()): Promise<void> {
  const due = await claimDueGuidanceRefreshes(now);
  for (const workspace of due) {
    try {
      const result = await refreshWorkspaceGuidance({
        workspaceId: workspace.workspaceId,
        actorUserId: null,
        source: "system",
        trigger: "schedule",
        cadence: workspace.cadence,
        at: now,
        claimedAt: now,
      });
      if (!result.ok) {
        console.warn(
          "[scheduler] guidance refresh skipped",
          workspace.workspaceId,
          result.error,
        );
      }
    } catch (error) {
      console.error(
        "[scheduler] guidance refresh threw",
        workspace.workspaceId,
        error,
      );
    }
  }
}
