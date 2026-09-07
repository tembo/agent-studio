ALTER TABLE run ADD COLUMN IF NOT EXISTS memory_warning TEXT;

CREATE TABLE IF NOT EXISTS workspace_memory (
    workspace_id UUID PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
    memory_workspace_id TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_identity (
    destination TEXT NOT NULL,
    memory_workspace_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (destination, memory_workspace_id, principal_id)
);

CREATE TABLE IF NOT EXISTS memory_run (
    run_id UUID PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    destination TEXT NOT NULL,
    memory_workspace_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    operator_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_outbox (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE RESTRICT,
    run_id UUID NOT NULL REFERENCES run(id) ON DELETE RESTRICT,
    user_id TEXT NOT NULL,
    destination TEXT NOT NULL,
    memory_workspace_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    operator_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    payload BYTEA,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'blocked', 'delivered')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_id UUID,
    lease_until TIMESTAMPTZ,
    last_error TEXT,
    report_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at TIMESTAMPTZ,
    UNIQUE (run_id, invocation_id)
);

CREATE INDEX IF NOT EXISTS memory_outbox_pending_idx
    ON memory_outbox (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS memory_outbox_workspace_idx ON memory_outbox (workspace_id, created_at);
