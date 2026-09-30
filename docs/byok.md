# BYOK — Bring Your Own Key

UROS supports organization-provided API keys for LLM and communication services.

## Overview

Organizations can configure their own API keys for:
- **LLM providers** — Groq, OpenAI, Anthropic (for enhanced extraction and recommendations)
- **Communication providers** — Twilio, SendGrid, WhatsApp Business API
- **Storage providers** — GCS, S3-compatible

## How It Works

1. Admin navigates to Settings → Credentials
2. Adds a new credential (provider, API key, label)
3. API key is encrypted at rest (AES-256-GCM) and masked in the UI
4. When the agent runs, it checks for org-specific credentials first
5. Falls back to platform defaults if no org key is configured

## Security

- API keys are encrypted before storage using the `ENCRYPTION_KEY` environment variable
- Keys are masked in the UI (showing only last 4 characters)
- Keys are never returned in API responses (only masked versions)
- Rotation: add a new key, update references, delete the old key
- Audit log records every credential CRUD operation

## Supported Providers

| Provider | Category | Usage |
|----------|----------|-------|
| Groq | LLM | Candidate extraction, improvement recommendations |
| OpenAI | LLM | Alternative LLM provider |
| Twilio | SMS | Candidate notifications |
| SendGrid | Email | Candidate communications |
| WhatsApp Business | Messaging | Candidate engagement |
| Google Cloud Storage | Storage | Document storage |

## Configuration

```
POST /api/v1/settings/credentials
{
  "provider": "groq",
  "api_key": "gsk_...",
  "label": "My Org Groq Key"
}
```

The key is encrypted and stored. The UI shows `****...abcd`.

## Fallback Behavior

If an org-specific key is invalid or rate-limited:
1. System logs the failure
2. Falls back to the next credential in the chain
3. If no credentials work, falls back to deterministic (non-LLM) processing
4. Alert sent to admin via communication dispatcher
