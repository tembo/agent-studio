-- Secret connections may be workspace-shared (user_id IS NULL) or personal.
-- Existing rows remain workspace-shared so their encryption AAD and behavior
-- do not change during the migration.

ALTER TABLE workspace_secret_connection
    ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;

ALTER TABLE workspace_secret_connection
    DROP CONSTRAINT IF EXISTS workspace_secret_connection_workspace_id_slug_key;

CREATE UNIQUE INDEX IF NOT EXISTS workspace_secret_connection_shared_slug_key
    ON workspace_secret_connection (workspace_id, slug)
    WHERE user_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS workspace_secret_connection_personal_slug_key
    ON workspace_secret_connection (workspace_id, user_id, slug)
    WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS workspace_secret_connection_user_idx
    ON workspace_secret_connection (workspace_id, user_id)
    WHERE user_id IS NOT NULL;
