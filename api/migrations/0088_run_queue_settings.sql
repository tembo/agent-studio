-- Instance-admin run-queue limits. Nullable so env
-- (API_MAX_CONCURRENT_RUNS / API_MAX_CONCURRENT_SUB_AGENTS_PER_ORCHESTRATOR)
-- keeps working until an admin saves a value in Instance settings.

ALTER TABLE instance_settings
    ADD COLUMN IF NOT EXISTS max_concurrent_runs INTEGER
        CHECK (max_concurrent_runs IS NULL OR max_concurrent_runs >= 1),
    ADD COLUMN IF NOT EXISTS max_sub_agents_per_orchestrator INTEGER
        CHECK (max_sub_agents_per_orchestrator IS NULL OR max_sub_agents_per_orchestrator >= 1);
