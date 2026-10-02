-- Better Auth JWT keys allow absent algorithm metadata on legacy rows.
-- Preserve key material and let the configured default handle existing keys.
ALTER TABLE jwks
    ADD COLUMN IF NOT EXISTS alg TEXT,
    ADD COLUMN IF NOT EXISTS crv TEXT;

ALTER TABLE jwks
    ALTER COLUMN alg DROP NOT NULL,
    ALTER COLUMN crv DROP NOT NULL;
