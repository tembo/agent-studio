-- One Twilio-backed text-message channel per workspace. Incoming messages to
-- the configured number route to a label-scoped agent; the run result is sent back
-- to the originating phone number. The Twilio auth token is encrypted by the
-- web process and decrypted by the runner only when it delivers the reply.

CREATE TABLE IF NOT EXISTS workspace_sms_channel (
    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id          UUID        NOT NULL UNIQUE REFERENCES workspace(id) ON DELETE CASCADE,
    account_sid           TEXT        NOT NULL,
    auth_token            BYTEA       NOT NULL,
    phone_number          TEXT        NOT NULL,
    allowed_numbers       TEXT[]      NOT NULL DEFAULT '{}',
    agent_labels          TEXT[]      NOT NULL DEFAULT '{}',
    default_owner_user_id TEXT        NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
    enabled               BOOLEAN     NOT NULL DEFAULT TRUE,
    created_by            TEXT        NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The delivery row is both the outbound destination and the per-number rate
-- limit ledger. Twilio's MessageSid is unique across webhook retries.
CREATE TABLE IF NOT EXISTS sms_delivery (
    run_id            UUID        PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
    sms_channel_id    UUID        NOT NULL REFERENCES workspace_sms_channel(id) ON DELETE CASCADE,
    inbound_sid       TEXT        NOT NULL UNIQUE,
    recipient_number  TEXT        NOT NULL,
    sender_number     TEXT        NOT NULL,
    provider_sid      TEXT,
    delivered_at      TIMESTAMPTZ,
    delivery_error    TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sms_event_seen (
    sms_channel_id UUID        NOT NULL REFERENCES workspace_sms_channel(id) ON DELETE CASCADE,
    inbound_sid    TEXT        NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (sms_channel_id, inbound_sid)
);

CREATE INDEX IF NOT EXISTS sms_delivery_rate_idx
    ON sms_delivery (sms_channel_id, recipient_number, created_at);
