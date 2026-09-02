-- Manual dry-run flag. Same agent/version as a normal run; declared
-- delivery tools are blocked at runtime. Excluded from success-rate
-- metrics. Default false so historical rows stay live runs.

ALTER TABLE run
    ADD COLUMN IF NOT EXISTS is_dry_run BOOLEAN NOT NULL DEFAULT false;
