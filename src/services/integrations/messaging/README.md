# messaging/* — Interface-Only Adapters (telegram, viber, signal)

**Status:** interface-only (MASTER Rule 18 exception). Awaiting live provider contributions.

## Contract

A live implementation must satisfy `Integration<HttpProviderConfig, SmsInput, SmsOutput>`:

| Member | Contract |
|---|---|
| `send(input, config)` | Delivers one template message via the provider business API. Returns `{ status: "SENT", data: { provider_message_id } }` on success; `{ status: "FAILED", error_code, error_message }` on definitive rejection; **throws** on transient failures (dispatcher retries). |
| `healthCheck(config)` | `true` iff reachable + credential authenticates. |
| `config.apiKey` | Provider token from the org's BYOK credential (`messaging_telegram` / `messaging_viber` / `messaging_signal`). |
| `config.baseUrl` | Provider API base from BYOK (required — never silently defaulted). |

## Registration

`CONNECTOR_TO_ADAPTER`: `messaging_telegram` → `messaging:telegram`, `messaging_viber` →
`messaging:viber`, `messaging_signal` → `messaging:signal` ([../_base/registry.ts](../_base/registry.ts)).

## Required tests

`tests/unit/integrations/interface_only.test.ts` asserts each throws
`ProviderNotImplementedError` on send(). Live contributions replace that file's
entries with mock-backed contract tests under `tests/mocks/`.
