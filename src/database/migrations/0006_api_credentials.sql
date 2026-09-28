-- 0006_api_credentials.sql
-- BYOK: organizations store their own connector credentials, encrypted at rest.
CREATE TABLE api_credentials (
    credential_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id           UUID NOT NULL REFERENCES organizations(org_id),
    connector        TEXT NOT NULL CHECK (connector IN
                      ('teletalk','bdjobs','linkedin','email','sms_provider',
                       'whatsapp_business','calendar','education_board','cib','police')),
    label            TEXT NOT NULL DEFAULT 'default',
    -- AES-256-GCM ciphertext components, each base64-encoded
    encrypted_value  TEXT NOT NULL,
    iv               TEXT NOT NULL,
    auth_tag         TEXT NOT NULL,
    base_url         TEXT,
    active           BOOLEAN NOT NULL DEFAULT true,
    created_by       UUID REFERENCES users(user_id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    rotated_at       TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_credential_org_connector_label
    ON api_credentials(org_id, connector, label) WHERE active = true;
CREATE INDEX idx_credentials_org_connector ON api_credentials(org_id, connector);
