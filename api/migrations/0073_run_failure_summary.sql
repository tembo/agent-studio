-- Separate safe, user-facing failure copy from the raw runner diagnostics in
-- error_message. Existing rows remain NULL and are rendered with a generic
-- fallback for non-admins; workspace admins may still inspect their details.
ALTER TABLE run
    ADD COLUMN IF NOT EXISTS failure_code TEXT,
    ADD COLUMN IF NOT EXISTS failure_summary TEXT,
    ADD COLUMN IF NOT EXISTS failure_recommendation TEXT;
