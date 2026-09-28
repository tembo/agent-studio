CREATE TABLE IF NOT EXISTS skill_owner (
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    skill_name TEXT NOT NULL,
    owner_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
    PRIMARY KEY (workspace_id, skill_name)
);
