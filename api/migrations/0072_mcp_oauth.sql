-- OAuth 2.1 authorization-server storage for remote MCP clients (Claude Web,
-- Claude Desktop, etc.). Better Auth's oauth-provider plugin owns the camelCase
-- tables below; TAS owns the final workspace-selection table that binds a
-- consent and every issued access token to one live workspace membership.

CREATE TABLE IF NOT EXISTS jwks (
    id           TEXT      PRIMARY KEY,
    "publicKey"  TEXT      NOT NULL,
    "privateKey" TEXT      NOT NULL,
    "createdAt"  TIMESTAMP NOT NULL,
    "expiresAt"  TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "oauthClient" (
    id                       TEXT      PRIMARY KEY,
    "clientId"               TEXT      NOT NULL UNIQUE,
    "clientSecret"           TEXT,
    disabled                 BOOLEAN   DEFAULT FALSE,
    "skipConsent"            BOOLEAN,
    "enableEndSession"       BOOLEAN,
    "subjectType"            TEXT,
    scopes                    TEXT,
    "userId"                 TEXT      REFERENCES "user"(id) ON DELETE CASCADE,
    "createdAt"              TIMESTAMP,
    "updatedAt"              TIMESTAMP,
    name                      TEXT,
    uri                       TEXT,
    icon                      TEXT,
    contacts                  TEXT,
    tos                       TEXT,
    policy                    TEXT,
    "softwareId"             TEXT,
    "softwareVersion"        TEXT,
    "softwareStatement"      TEXT,
    "redirectUris"           TEXT      NOT NULL,
    "postLogoutRedirectUris" TEXT,
    "tokenEndpointAuthMethod" TEXT,
    "grantTypes"             TEXT,
    "responseTypes"          TEXT,
    public                    BOOLEAN,
    type                      TEXT,
    "requirePKCE"            BOOLEAN,
    "referenceId"            TEXT,
    metadata                  JSONB
);

CREATE INDEX IF NOT EXISTS oauth_client_user_id_idx
    ON "oauthClient"("userId");

CREATE TABLE IF NOT EXISTS "oauthRefreshToken" (
    id            TEXT      PRIMARY KEY,
    token         TEXT      NOT NULL UNIQUE,
    "clientId"    TEXT      NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
    "sessionId"   TEXT      REFERENCES session(id) ON DELETE SET NULL,
    "userId"      TEXT      NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    "referenceId" TEXT,
    "expiresAt"   TIMESTAMP NOT NULL,
    "createdAt"   TIMESTAMP NOT NULL,
    revoked        TIMESTAMP,
    "authTime"    TIMESTAMP,
    scopes         TEXT      NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_refresh_client_id_idx
    ON "oauthRefreshToken"("clientId");
CREATE INDEX IF NOT EXISTS oauth_refresh_session_id_idx
    ON "oauthRefreshToken"("sessionId");
CREATE INDEX IF NOT EXISTS oauth_refresh_user_id_idx
    ON "oauthRefreshToken"("userId");

CREATE TABLE IF NOT EXISTS "oauthAccessToken" (
    id            TEXT      PRIMARY KEY,
    token         TEXT      UNIQUE,
    "clientId"    TEXT      NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
    "sessionId"   TEXT      REFERENCES session(id) ON DELETE SET NULL,
    "userId"      TEXT      REFERENCES "user"(id) ON DELETE CASCADE,
    "referenceId" TEXT,
    "refreshId"   TEXT      REFERENCES "oauthRefreshToken"(id) ON DELETE CASCADE,
    "expiresAt"   TIMESTAMP NOT NULL,
    "createdAt"   TIMESTAMP NOT NULL,
    scopes         TEXT      NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_access_client_id_idx
    ON "oauthAccessToken"("clientId");
CREATE INDEX IF NOT EXISTS oauth_access_session_id_idx
    ON "oauthAccessToken"("sessionId");
CREATE INDEX IF NOT EXISTS oauth_access_user_id_idx
    ON "oauthAccessToken"("userId");
CREATE INDEX IF NOT EXISTS oauth_access_refresh_id_idx
    ON "oauthAccessToken"("refreshId");

CREATE TABLE IF NOT EXISTS "oauthConsent" (
    id            TEXT      PRIMARY KEY,
    "clientId"    TEXT      NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
    "userId"      TEXT      REFERENCES "user"(id) ON DELETE CASCADE,
    "referenceId" TEXT,
    scopes         TEXT      NOT NULL,
    "createdAt"   TIMESTAMP NOT NULL,
    "updatedAt"   TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_consent_client_id_idx
    ON "oauthConsent"("clientId");
CREATE INDEX IF NOT EXISTS oauth_consent_user_id_idx
    ON "oauthConsent"("userId");

CREATE TABLE IF NOT EXISTS mcp_oauth_workspace_selection (
    session_id   TEXT        PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
    user_id      TEXT        NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    workspace_id UUID        NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    selected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
