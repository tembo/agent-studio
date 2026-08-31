-- Durable dispatch history for schedules, Composio triggers, and inbound
-- webhooks. Parent rows keep only the current safe health summary; failures and
-- their eventual recovery remain inspectable here after edits and retries.

CREATE TABLE IF NOT EXISTS automation_dispatch_event (
    id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id           UUID        NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    automation_kind        TEXT        NOT NULL
        CHECK (automation_kind IN ('schedule', 'trigger', 'webhook')),
    automation_id          UUID        NOT NULL,
    automation_name        TEXT        NOT NULL,
    agent_name             TEXT        NOT NULL,
    outcome                TEXT        NOT NULL
        CHECK (outcome IN ('failed', 'resolved')),
    attempt                INTEGER     NOT NULL CHECK (attempt > 0),
    failure_code           TEXT,
    failure_summary        TEXT,
    failure_recommendation TEXT,
    diagnostic_detail      TEXT,
    run_id                 UUID        REFERENCES run(id) ON DELETE SET NULL,
    occurred_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at            TIMESTAMPTZ,
    CHECK (
        (outcome = 'failed' AND failure_code IS NOT NULL AND failure_summary IS NOT NULL)
        OR
        (outcome = 'resolved' AND failure_code IS NULL AND failure_summary IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS automation_dispatch_event_source_idx
    ON automation_dispatch_event
       (workspace_id, automation_kind, automation_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS automation_dispatch_event_workspace_idx
    ON automation_dispatch_event (workspace_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS automation_dispatch_event_run_idx
    ON automation_dispatch_event (run_id) WHERE run_id IS NOT NULL;

ALTER TABLE automation
    ADD COLUMN IF NOT EXISTS last_fire_event_id UUID
        REFERENCES automation_dispatch_event(id) ON DELETE SET NULL;

ALTER TABLE workspace_trigger
    ADD COLUMN IF NOT EXISTS last_fire_event_id UUID
        REFERENCES automation_dispatch_event(id) ON DELETE SET NULL;

ALTER TABLE workspace_webhook
    ADD COLUMN IF NOT EXISTS last_fire_event_id UUID
        REFERENCES automation_dispatch_event(id) ON DELETE SET NULL;

-- Existing mutable errors may contain unclassified upstream text. Preserve the
-- fact and timestamp of those failures without copying potentially sensitive
-- legacy detail into the durable diagnostics column.
WITH inserted AS (
    INSERT INTO automation_dispatch_event
        (workspace_id, automation_kind, automation_id, automation_name,
         agent_name, outcome, attempt, failure_code, failure_summary,
         failure_recommendation, occurred_at)
    SELECT workspace_id, 'schedule', id, name, agent_name, 'failed', 1,
           'legacy_automation_error',
           'The automation previously failed to dispatch.',
           'Review the automation and try again.',
           updated_at
      FROM automation
     WHERE last_fire_error IS NOT NULL AND last_fire_event_id IS NULL
    RETURNING id, automation_id, failure_summary
)
UPDATE automation target
   SET last_fire_error = inserted.failure_summary,
       last_fire_event_id = inserted.id
  FROM inserted
 WHERE target.id = inserted.automation_id;

WITH inserted AS (
    INSERT INTO automation_dispatch_event
        (workspace_id, automation_kind, automation_id, automation_name,
         agent_name, outcome, attempt, failure_code, failure_summary,
         failure_recommendation, occurred_at)
    SELECT workspace_id, 'trigger', id, trigger_type, agent_name, 'failed', 1,
           'legacy_automation_error',
           'The automation previously failed to dispatch.',
           'Review the automation and try again.',
           updated_at
      FROM workspace_trigger
     WHERE last_fire_error IS NOT NULL AND last_fire_event_id IS NULL
    RETURNING id, automation_id, failure_summary
)
UPDATE workspace_trigger target
   SET last_fire_error = inserted.failure_summary,
       last_fire_event_id = inserted.id
  FROM inserted
 WHERE target.id = inserted.automation_id;

WITH inserted AS (
    INSERT INTO automation_dispatch_event
        (workspace_id, automation_kind, automation_id, automation_name,
         agent_name, outcome, attempt, failure_code, failure_summary,
         failure_recommendation, occurred_at)
    SELECT workspace_id, 'webhook', id, name, agent_name, 'failed', 1,
           'legacy_automation_error',
           'The automation previously failed to dispatch.',
           'Review the automation and try again.',
           updated_at
      FROM workspace_webhook
     WHERE last_fire_error IS NOT NULL AND last_fire_event_id IS NULL
    RETURNING id, automation_id, failure_summary
)
UPDATE workspace_webhook target
   SET last_fire_error = inserted.failure_summary,
       last_fire_event_id = inserted.id
  FROM inserted
 WHERE target.id = inserted.automation_id;
