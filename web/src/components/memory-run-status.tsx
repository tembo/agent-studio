import { db } from "@/lib/db";

export async function MemoryRunStatus({ workspaceId, runId }: { workspaceId: string; runId: string }) {
  const result = await db.query<{ memory_warning: string | null; attached: boolean; queued: string; delivered: string; blocked: string }>(
    `SELECT r.memory_warning, EXISTS(SELECT 1 FROM memory_run WHERE run_id = r.id) AS attached,
       (SELECT count(*) FROM memory_outbox WHERE run_id = r.id AND status = 'pending') AS queued,
       (SELECT count(*) FROM memory_outbox WHERE run_id = r.id AND status = 'delivered') AS delivered,
       (SELECT count(*) FROM memory_outbox WHERE run_id = r.id AND status = 'blocked') AS blocked
     FROM run r WHERE r.id = $1 AND r.workspace_id = $2`, [runId, workspaceId],
  );
  const status = result.rows[0];
  if (!status || (!status.attached && !status.memory_warning)) return null;
  return <div className="rounded border border-[var(--color-border-weak)] p-3 text-sm" role="status">
    <p>Memory reports: {status.queued} queued · {status.delivered} delivered · {status.blocked} blocked</p>
    {status.memory_warning && <p className="text-sentiment-negative">Memory warning: {status.memory_warning}</p>}
    <p className="text-foreground-muted">Delivery continues after this run finishes. Refresh for updated status. Delivered means accepted by Memory, not necessarily extracted yet.</p>
  </div>;
}
