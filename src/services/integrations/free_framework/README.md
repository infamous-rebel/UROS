# free_framework — Interface-Only Adapter

**Status:** interface-only (MASTER Rule 18 exception). Awaiting a live provider contribution.

## Contract

A live implementation must satisfy `Integration<HttpProviderConfig, SmsInput, SmsOutput>`:

| Member | Contract |
|---|---|
| `send(input, config)` | Delivers one SMS via the free-framework gateway. Returns `{ status: "SENT", data: { provider_message_id } }` on success; returns `{ status: "FAILED", error_code, error_message }` for definitive provider rejections; **throws** on transient network/5xx failures (the dispatcher retries throws). |
| `healthCheck(config)` | Returns `true` iff the gateway is reachable and the credential authenticates. |
| `config.apiKey` | Bearer credential resolved from the org's BYOK `free_sms` credential. |
| `config.baseUrl` | Endpoint base URL from the org's BYOK credential. Required — never silently defaulted. |

## Registration

Registered in `CONNECTOR_TO_ADAPTER` as connector `free_sms` → `{ category: "free_framework", provider: "free_framework" }` ([../_base/registry.ts](../_base/registry.ts)).

## Required tests

Any live contribution must keep the assertion that `send()` on the interface-only
placeholder throws `ProviderNotImplementedError` (tests/unit/integrations/interface_only.test.ts)
or replace it with contract tests against a mock provider under `tests/mocks/`.
