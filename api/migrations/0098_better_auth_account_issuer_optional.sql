-- Better Auth 1.7.3+ identifies accounts by providerId/accountId and no longer
-- writes issuer. Preserve its historical values without blocking new accounts.
ALTER TABLE account ALTER COLUMN issuer DROP NOT NULL;
DROP INDEX IF EXISTS "account_issuer_accountId_uidx";

-- account_provider_account_idx from migration 0001 remains the identity key.
