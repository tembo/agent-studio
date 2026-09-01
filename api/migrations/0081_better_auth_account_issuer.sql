-- Better Auth 1.7 keys accounts by (issuer, accountId). Backfill the exact
-- namespaces used by TAS's configured providers so existing social and
-- credential accounts continue to resolve to the same users after the upgrade.

ALTER TABLE account ADD COLUMN IF NOT EXISTS issuer TEXT;

DO $$
DECLARE
    unsupported_provider_ids TEXT;
BEGIN
    SELECT string_agg(DISTINCT "providerId", ', ' ORDER BY "providerId")
      INTO unsupported_provider_ids
      FROM account
     WHERE "providerId" NOT IN ('credential', 'google', 'microsoft', 'oidc');

    IF unsupported_provider_ids IS NOT NULL THEN
        RAISE EXCEPTION
            'Cannot backfill Better Auth account issuers for unknown provider IDs: %. Add an explicit provider-to-issuer mapping before upgrading.',
            unsupported_provider_ids;
    END IF;
END $$;

UPDATE account
   SET issuer = CASE "providerId"
       WHEN 'credential' THEN 'local:credential'
       WHEN 'google' THEN 'https://accounts.google.com'
       ELSE 'local:oauth:' || "providerId"
   END;

ALTER TABLE account ALTER COLUMN issuer SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "account_issuer_accountId_uidx"
    ON account (issuer, "accountId");
