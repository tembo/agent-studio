-- Allow workspace-scoped Fireworks inference credentials.
ALTER TABLE workspace_secret DROP CONSTRAINT IF EXISTS workspace_secret_kind_check;
ALTER TABLE workspace_secret
    ADD CONSTRAINT workspace_secret_kind_check
    CHECK (kind IN (
        'tembo_api_key',
        'github_pat',
        'anthropic_api_key',
        'openai_api_key',
        'fireworks_api_key',
        'scaledown_api_key',
        'composio_api_key',
        'composio_webhook_secret',
        'attio_oauth_client_id',
        'attio_oauth_client_secret'
    ));
