-- 0032_integrations_quest04.sql
-- Quest 04: Integrations & Transports (Full Rebuild)
--
-- 1. Widen api_credentials.connector CHECK to include all Quest 04 connector names.
-- 2. Extend communication_log with provider tracking columns.
-- 3. Add 'QUEUED' to communication_log.status CHECK.
-- 4. Create whatsapp_inbound_messages table.
-- 5. Create integration_fallback_configs table.
-- 6. Create whatsapp_templates table.

-- 1. Widen api_credentials.connector CHECK constraint.
ALTER TABLE api_credentials DROP CONSTRAINT IF EXISTS api_credentials_connector_check;
ALTER TABLE api_credentials ADD CONSTRAINT api_credentials_connector_check
    CHECK (connector IN (
        -- Legacy (pre-Quest 04)
        'teletalk','bdjobs','linkedin','email','sms_provider',
        'whatsapp_business','calendar','education_board','cib','police','llm',
        -- Quest 04 — SMS providers
        'sms_teletalk','sms_grameenphone','sms_banglalink','sms_robi','sms_airtel',
        'sms_ssl_wireless','sms_alpha_sms','sms_bulk_sms_bd','sms_generic_http',
        -- Quest 04 — VOIP
        'voip',
        -- Quest 04 — Email providers
        'email_smtp','email_imap','email_gmail_api','email_graph','email_sendgrid','email_ses',
        -- Quest 04 — WhatsApp
        'whatsapp_meta',
        -- Quest 04 — bdjobs
        'bdjobs_scraper','bdjobs_csv','bdjobs_email','bdjobs_webhook',
        -- Quest 04 — Calendar
        'calendar_google','calendar_outlook','calendar_ical',
        -- Quest 04 — Teletalk (top-level)
        'teletalk_sms','teletalk_cv_bank',
        -- Quest 04 — Interface-only / free-framework
        'free_sms','messaging_telegram','messaging_viber','messaging_signal'
    ));

-- 2. Extend communication_log with provider tracking columns.
ALTER TABLE communication_log ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
ALTER TABLE communication_log ADD COLUMN IF NOT EXISTS provider_name TEXT;
ALTER TABLE communication_log ADD COLUMN IF NOT EXISTS error_code TEXT;
ALTER TABLE communication_log ADD COLUMN IF NOT EXISTS error_message TEXT;

-- 3. Add 'QUEUED' to communication_log.status CHECK.
ALTER TABLE communication_log DROP CONSTRAINT IF EXISTS communication_log_status_check;
ALTER TABLE communication_log ADD CONSTRAINT communication_log_status_check
    CHECK (status IN ('QUEUED','SENT','FAILED','RETRIED','DELIVERED'));

-- 4. Create whatsapp_inbound_messages table.
CREATE TABLE IF NOT EXISTS whatsapp_inbound_messages (
    message_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              UUID REFERENCES organizations(org_id),
    from_phone          TEXT NOT NULL,
    provider_message_id TEXT NOT NULL,
    body                TEXT,
    media_url           TEXT,
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed           BOOLEAN NOT NULL DEFAULT false,
    processed_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_inbound_org
    ON whatsapp_inbound_messages(org_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_inbound_provider_msg
    ON whatsapp_inbound_messages(provider_message_id);

-- 5. Create integration_fallback_configs table.
CREATE TABLE IF NOT EXISTS integration_fallback_configs (
    config_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(org_id),
    message_type    TEXT NOT NULL,  -- 'SMS', 'EMAIL', 'WHATSAPP'
    provider_order  JSONB NOT NULL, -- ordered array: ["sms_teletalk","sms_grameenphone"]
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(org_id, message_type)
);

-- 6. Create whatsapp_templates table.
CREATE TABLE IF NOT EXISTS whatsapp_templates (
    template_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(org_id),
    template_name   TEXT NOT NULL,
    language        TEXT NOT NULL DEFAULT 'en',
    body            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','APPROVED','REJECTED')),
    meta_template_id TEXT,
    rejection_reason TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(org_id, template_name, language)
);
