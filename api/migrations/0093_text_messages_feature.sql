ALTER TABLE workspace
    ADD COLUMN IF NOT EXISTS text_messages_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Preserve navigation for workspaces already using text messages.
UPDATE workspace w
SET text_messages_enabled = TRUE
WHERE EXISTS (SELECT 1 FROM workspace_sms_channel c WHERE c.workspace_id = w.id);
