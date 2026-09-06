-- Replace the channel-level sender allowlist and fallback owner with verified,
-- workspace-scoped member identity, and allow multiple named SMS channels per
-- workspace. The legacy columns stay in place so existing channel
-- configuration remains recoverable during rollout; new code no longer reads
-- them.

ALTER TABLE workspace_sms_channel
    DROP CONSTRAINT IF EXISTS workspace_sms_channel_workspace_id_key;

ALTER TABLE workspace_sms_channel
    ADD COLUMN IF NOT EXISTS name TEXT;

UPDATE workspace_sms_channel
SET name = phone_number
WHERE name IS NULL;

ALTER TABLE workspace_sms_channel
    ALTER COLUMN name SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS workspace_sms_channel_workspace_name_idx
    ON workspace_sms_channel (workspace_id, lower(name));

ALTER TABLE workspace_sms_channel
    ALTER COLUMN default_owner_user_id DROP NOT NULL;

ALTER TABLE workspace_member
    ADD COLUMN IF NOT EXISTS sms_phone_number TEXT
        CHECK (sms_phone_number IS NULL OR sms_phone_number ~ '^\+[1-9][0-9]{7,14}$');

CREATE UNIQUE INDEX IF NOT EXISTS workspace_member_sms_phone_number_idx
    ON workspace_member (workspace_id, sms_phone_number)
    WHERE sms_phone_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_sms_link_code (
    workspace_id UUID        NOT NULL,
    user_id      TEXT        NOT NULL,
    code_hash    TEXT        NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id),
    UNIQUE (workspace_id, code_hash),
    FOREIGN KEY (workspace_id, user_id)
        REFERENCES workspace_member(workspace_id, user_id) ON DELETE CASCADE
);
