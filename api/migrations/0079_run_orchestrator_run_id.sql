-- Name the run relationship after its orchestration role. Existing values are
-- preserved; only the column and its supporting database objects are renamed.
ALTER TABLE run
    RENAME COLUMN parent_run_id TO orchestrator_run_id;

ALTER INDEX run_parent_run_id_idx
    RENAME TO run_orchestrator_run_id_idx;

ALTER TABLE run
    RENAME CONSTRAINT run_parent_run_id_fkey TO run_orchestrator_run_id_fkey;
