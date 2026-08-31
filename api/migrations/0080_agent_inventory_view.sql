-- Named agent-inventory views. Filters are UI preferences, not agent metadata:
-- orchestration roles continue to be inferred from observed run relationships.
CREATE TABLE IF NOT EXISTS agent_inventory_view (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID       NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    created_by  TEXT        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    name        TEXT        NOT NULL,
    visibility  TEXT        NOT NULL CHECK (visibility IN ('personal', 'shared')),
    filters     JSONB       NOT NULL DEFAULT '{}'::JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 80)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_inventory_view_personal_name_idx
    ON agent_inventory_view (workspace_id, created_by, lower(name))
    WHERE visibility = 'personal';

CREATE UNIQUE INDEX IF NOT EXISTS agent_inventory_view_shared_name_idx
    ON agent_inventory_view (workspace_id, lower(name))
    WHERE visibility = 'shared';

CREATE INDEX IF NOT EXISTS agent_inventory_view_workspace_idx
    ON agent_inventory_view (workspace_id, visibility, created_by);
