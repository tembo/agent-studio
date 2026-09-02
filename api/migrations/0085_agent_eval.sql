-- Agent eval suites: one row per suite execution (CI or in-app). Case
-- results live as JSON so we can add scoring fields without a migration
-- per check type. Eval-triggered agent runs use trigger='eval' so they
-- stay out of the default Runs list.

CREATE TABLE IF NOT EXISTS agent_eval_run (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id         UUID        NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    agent_name           TEXT        NOT NULL,
    agent_version_id     UUID        REFERENCES agent_version(id) ON DELETE SET NULL,
    agent_version_label  TEXT        NOT NULL,
    source               TEXT        NOT NULL DEFAULT 'api'
                         CHECK (source IN ('ci', 'manual', 'api', 'pr')),
    commit_sha           TEXT,
    spec_hash            TEXT,
    status               TEXT        NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued', 'running', 'passed', 'failed', 'error')),
    passed_count         INTEGER     NOT NULL DEFAULT 0,
    failed_count         INTEGER     NOT NULL DEFAULT 0,
    error_message        TEXT,
    case_results         JSONB       NOT NULL DEFAULT '[]'::jsonb,
    created_by           TEXT        NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS agent_eval_run_workspace_agent_recent_idx
    ON agent_eval_run (workspace_id, agent_name, created_at DESC);

ALTER TABLE run DROP CONSTRAINT IF EXISTS run_trigger_check;
ALTER TABLE run
    ADD CONSTRAINT run_trigger_check
    CHECK (trigger IN ('manual', 'schedule', 'event', 'eval'));
