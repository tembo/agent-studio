-- Support complete cursor pages when many runs share a timestamp.
-- Keep the older index until deployments can assess its other query users.
CREATE INDEX IF NOT EXISTS run_workspace_cursor_idx
    ON run (workspace_id, created_at DESC, id DESC);
