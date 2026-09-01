-- Optional automatic refresh for TAS-managed authoring guidance in each
-- workspace's connected repository. The timestamp is the cadence floor for
-- both manual and scheduled checks; the sync itself remains idempotent and
-- only commits files whose canonical content changed.

ALTER TABLE workspace
    ADD COLUMN IF NOT EXISTS guidance_refresh_cadence TEXT NOT NULL DEFAULT 'off'
        CHECK (guidance_refresh_cadence IN ('off', 'daily', 'weekly')),
    ADD COLUMN IF NOT EXISTS guidance_refreshed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS workspace_guidance_refresh_enabled_idx
    ON workspace(guidance_refresh_cadence, guidance_refreshed_at)
    WHERE guidance_refresh_cadence <> 'off';
