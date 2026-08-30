-- Durable, non-secret diagnostics for native-MCP OAuth refreshes. The
-- encrypted credential blob remains the only place tokens are stored; these
-- columns contain stable error codes and safe user-facing copy only.
ALTER TABLE workspace_connection
    ADD COLUMN IF NOT EXISTS refresh_error_code TEXT,
    ADD COLUMN IF NOT EXISTS refresh_error_message TEXT,
    ADD COLUMN IF NOT EXISTS refresh_error_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS refresh_failure_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS refresh_retry_at TIMESTAMPTZ;

ALTER TABLE workspace_connection
    ADD CONSTRAINT workspace_connection_refresh_failure_count_check
    CHECK (refresh_failure_count >= 0);
