-- Snapshot whether each run belongs to production or development analytics.
-- Draft specs are development; promoted version snapshots are production.
-- The API enforces inheritance for sub-runs at creation time.

ALTER TABLE run
    ADD COLUMN IF NOT EXISTS run_environment TEXT NOT NULL DEFAULT 'production';

-- Classify historical root runs from their recorded lifecycle. Pre-version
-- runs remain production because their original lifecycle cannot be
-- reconstructed safely.
UPDATE run
   SET run_environment = 'development'
 WHERE orchestrator_run_id IS NULL
   AND agent_version_label = 'draft';

-- Historical sub-runs inherit from the top-level run, just like new sub-runs.
-- Carry the root value down one generation at a time so nested orchestration
-- remains predictable too.
WITH RECURSIVE run_tree AS (
    SELECT id, run_environment
      FROM run
     WHERE orchestrator_run_id IS NULL
    UNION ALL
    SELECT child.id, parent.run_environment
      FROM run child
      JOIN run_tree parent ON parent.id = child.orchestrator_run_id
)
UPDATE run
   SET run_environment = run_tree.run_environment
  FROM run_tree
 WHERE run.id = run_tree.id;

ALTER TABLE run DROP CONSTRAINT IF EXISTS run_environment_check;
ALTER TABLE run
    ADD CONSTRAINT run_environment_check
    CHECK (run_environment IN ('production', 'development'));

CREATE INDEX IF NOT EXISTS run_workspace_environment_recent_idx
    ON run (workspace_id, run_environment, created_at DESC);
