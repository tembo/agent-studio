-- OAuth Provider 1.7 promotes protected resources and sender-constrained
-- tokens to first-class records. Keep the upgrade additive so existing MCP
-- clients, consents, and tokens remain usable while new rows gain 1.7 fields.

ALTER TABLE "oauthClient"
    ADD COLUMN IF NOT EXISTS "clientDiscoveryId" TEXT,
    ADD COLUMN IF NOT EXISTS "clientCredentialsScopes" TEXT,
    ADD COLUMN IF NOT EXISTS "backchannelLogoutUri" TEXT,
    ADD COLUMN IF NOT EXISTS "backchannelLogoutSessionRequired" BOOLEAN,
    ADD COLUMN IF NOT EXISTS "applicationType" TEXT,
    ADD COLUMN IF NOT EXISTS jwks TEXT,
    ADD COLUMN IF NOT EXISTS "jwksUri" TEXT,
    ADD COLUMN IF NOT EXISTS "dpopBoundAccessTokens" BOOLEAN DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS "oauthResource" (
    id                                TEXT PRIMARY KEY,
    identifier                        TEXT NOT NULL UNIQUE,
    name                              TEXT NOT NULL,
    "accessTokenTtl"                  INTEGER,
    "refreshTokenTtl"                 INTEGER,
    "signingAlgorithm"                TEXT,
    "signingKeyId"                    TEXT,
    "allowedScopes"                   TEXT,
    "customClaims"                    JSONB,
    "dpopBoundAccessTokensRequired"   BOOLEAN DEFAULT FALSE,
    disabled                          BOOLEAN DEFAULT FALSE,
    "createdAt"                       TIMESTAMP,
    "updatedAt"                       TIMESTAMP,
    "policyVersion"                   INTEGER DEFAULT 1,
    metadata                          JSONB
);

CREATE TABLE IF NOT EXISTS "oauthClientResource" (
    id           TEXT PRIMARY KEY,
    "clientId"   TEXT NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
    "resourceId" TEXT NOT NULL REFERENCES "oauthResource"(identifier) ON DELETE CASCADE,
    metadata     JSONB,
    "createdAt"  TIMESTAMP,
    UNIQUE ("clientId", "resourceId")
);

CREATE INDEX IF NOT EXISTS oauth_client_resource_client_id_idx
    ON "oauthClientResource"("clientId");
CREATE INDEX IF NOT EXISTS oauth_client_resource_resource_id_idx
    ON "oauthClientResource"("resourceId");

ALTER TABLE "oauthRefreshToken"
    ADD COLUMN IF NOT EXISTS "authorizationCodeId" TEXT,
    ADD COLUMN IF NOT EXISTS resources TEXT,
    ADD COLUMN IF NOT EXISTS "requestedUserInfoClaims" TEXT,
    ADD COLUMN IF NOT EXISTS "rotatedAt" TIMESTAMP,
    ADD COLUMN IF NOT EXISTS "rotationReplayResponse" TEXT,
    ADD COLUMN IF NOT EXISTS "rotationReplayExpiresAt" TIMESTAMP,
    ADD COLUMN IF NOT EXISTS confirmation JSONB;

CREATE INDEX IF NOT EXISTS oauth_refresh_authorization_code_id_idx
    ON "oauthRefreshToken"("authorizationCodeId");

ALTER TABLE "oauthAccessToken"
    ADD COLUMN IF NOT EXISTS "authorizationCodeId" TEXT,
    ADD COLUMN IF NOT EXISTS resources TEXT,
    ADD COLUMN IF NOT EXISTS "requestedUserInfoClaims" TEXT,
    ADD COLUMN IF NOT EXISTS revoked TIMESTAMP,
    ADD COLUMN IF NOT EXISTS confirmation JSONB;

CREATE INDEX IF NOT EXISTS oauth_access_authorization_code_id_idx
    ON "oauthAccessToken"("authorizationCodeId");

ALTER TABLE "oauthConsent"
    ADD COLUMN IF NOT EXISTS resources TEXT,
    ADD COLUMN IF NOT EXISTS "requestedUserInfoClaims" TEXT;

CREATE TABLE IF NOT EXISTS "oauthClientAssertion" (
    id          TEXT PRIMARY KEY,
    "expiresAt" TIMESTAMP NOT NULL
);
