-- Run search keeps the existing substring semantics across input, output, and
-- failure text while adding agent-name lookup. A trigram GIN index prevents a
-- workspace's complete run history from being scanned for each search.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS run_search_text_trgm_idx
    ON run USING GIN ((
        agent_name || E'\n' ||
        COALESCE(user_message, '') || E'\n' ||
        COALESCE(output, '') || E'\n' ||
        COALESCE(failure_summary, '') || E'\n' ||
        COALESCE(error_message, '')
    ) gin_trgm_ops);

-- Matching a display name/email resolves to acting user IDs first. This index
-- keeps that identity branch workspace-scoped and ordered for recent results.
CREATE INDEX IF NOT EXISTS run_workspace_created_by_recent_idx
    ON run (workspace_id, created_by, created_at DESC);
