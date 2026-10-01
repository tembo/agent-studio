-- Opt-in reuse preserves a child run for every request. Reused runs point to
-- the original producer and never themselves become cache candidates.
ALTER TABLE run
    ADD COLUMN IF NOT EXISTS output_reuse_key TEXT,
    ADD COLUMN IF NOT EXISTS output_reuse_type TEXT,
    ADD COLUMN IF NOT EXISTS reused_from_run_id UUID REFERENCES run(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS run_output_reuse_idx
    ON run (workspace_id, created_by, output_reuse_key, completed_at DESC)
    WHERE status = 'succeeded' AND reused_from_run_id IS NULL;
