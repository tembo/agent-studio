-- Configurable sign-up policy (invite-only / domain allowlist / open).
-- Nullable so an env-configured deployment (TAS_SIGNUP_POLICY /
-- TAS_SIGNUP_ALLOWED_DOMAINS) keeps working until an instance admin
-- saves a value here. Unset → invite-only, matching the previous
-- hardwired gate. Writes are instance-admin-gated in the web layer.

ALTER TABLE instance_settings
    ADD COLUMN IF NOT EXISTS signup_policy TEXT
        CHECK (signup_policy IS NULL OR signup_policy IN (
            'invite_only', 'domain_allowlist', 'open'
        )),
    ADD COLUMN IF NOT EXISTS signup_allowed_domains TEXT[];
