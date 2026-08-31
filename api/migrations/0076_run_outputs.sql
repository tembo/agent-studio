-- Searchable output library. The run row remains the canonical copy of the
-- output; these columns only add search and immutable delivery provenance.

ALTER TABLE run
    ADD COLUMN IF NOT EXISTS output_search TSVECTOR
        GENERATED ALWAYS AS (
            to_tsvector('english'::regconfig, COALESCE(output, ''))
        ) STORED,
    ADD COLUMN IF NOT EXISTS output_delivery JSONB,
    ADD COLUMN IF NOT EXISTS delivery_evidence JSONB,
    ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'undeclared';

ALTER TABLE run DROP CONSTRAINT IF EXISTS run_delivery_status_check;
ALTER TABLE run
    ADD CONSTRAINT run_delivery_status_check
    CHECK (delivery_status IN (
        'confirmed', 'partial', 'failed', 'unobserved', 'undeclared'
    ));

CREATE INDEX IF NOT EXISTS run_output_search_idx
    ON run USING GIN (output_search)
    WHERE status = 'succeeded' AND BTRIM(output) <> '';

CREATE INDEX IF NOT EXISTS run_workspace_outputs_recent_idx
    ON run (workspace_id, completed_at DESC, id DESC)
    WHERE status = 'succeeded' AND BTRIM(output) <> '';

CREATE INDEX IF NOT EXISTS run_workspace_outputs_delivery_idx
    ON run (workspace_id, delivery_status, completed_at DESC, id DESC)
    WHERE status = 'succeeded' AND BTRIM(output) <> '';
