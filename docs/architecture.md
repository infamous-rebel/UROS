# Architecture

## Integration Registry & Communication Dispatcher (Quest 04)

Every outbound message and connector invocation flows through one path: the communication dispatcher (`src/services/communication/dispatcher.ts`). Every provider integration lives behind a uniform adapter contract (`Integration<TConfig, TInput, TOutput>`) in `src/services/integrations/` — 31 adapters across SMS, VOIP, email, WhatsApp, bdjobs, LinkedIn, calendar, Teletalk, and interface-only messaging, registered centrally and idempotently by `register_all.ts` at every boot entrypoint.

```mermaid
flowchart TD
    CALLER["sendBatch / routes / agents"] --> DP["dispatchMessage(org, type, msg, meta)"]
    DP --> CH{"integration_fallback_configs<br/>for org + type?"}
    CH -- "configured" --> ORDERED["org's provider_order"]
    CH -- "not configured" --> DEF["CHANNEL_DEFAULT_CHAINS<br/>SMS→sms_provider, EMAIL→email,<br/>WHATSAPP→whatsapp_business"]
    ORDERED --> LOOP{"next provider<br/>in chain"}
    DEF --> LOOP
    LOOP --> LEG{"legacy connector?"}
    LEG -- "yes" --> OLD["sendViaLegacy<br/>(sms_provider / email / whatsapp_business —<br/>own communication_log writes)"]
    LEG -- "no" --> REG["sendViaRegistry"]
    REG --> CRED{"BYOK credential?"}
    CRED -- "missing" --> SKIP["skipped: MISSING_CREDENTIAL<br/>→ next provider"]
    CRED -- "yes" --> RL{"rate limit<br/>token bucket"}
    RL -- "empty" --> SKIP2["skipped: RATE_LIMITED"]
    RL -- "ok" --> CB{"circuit<br/>breaker"}
    CB -- "open" --> SKIP3["skipped: CIRCUIT_OPEN"]
    CB -- "closed" --> RETRY["withRetry<br/>(4xx/malformed = definitive FAILED;<br/>5xx/network = transient, retried)"]
    RETRY --> OK{"result?"}
    OK -- "SENT" --> LOG["communication_log row<br/>(provider_message_id, provider_name)<br/>+ MESSAGE_DISPATCHED audit"]
    OK -- "FAILED" --> NEXTP["next provider in chain"]
    SKIP --> NEXTP
    SKIP2 --> NEXTP
    SKIP3 --> NEXTP
    NEXTP --> LOOP
    LOG --> DONE["return DispatchOutcome"]

    style LOG fill:#0F766E,color:#fff
    style SKIP fill:#E2725B,color:#fff
    style SKIP2 fill:#E2725B,color:#fff
    style SKIP3 fill:#E2725B,color:#fff
```

Key invariants:

- **Single source of truth**: `CONNECTOR_TO_ADAPTER` in `src/services/integrations/_base/registry.ts` maps every DB connector name to its adapter (30 names → 31 adapters).
- **No silent failures**: every attempt outcome lands in `communication_log` (registry path writes provider-tracked rows; the legacy bridge delegates to connectors that log their own rows) and the audit trail (`MESSAGE_DISPATCHED` / `MESSAGE_DISPATCH_FAILED`).
- **BYOK only**: adapters receive `baseUrl`/`apiKey` from the org's `api_credentials` row and never branch on `NODE_ENV` or fall back to defaults; missing credentials throw `MissingCredentialError` (the dispatcher treats it as a skipped provider, not a crash).
- **Definitive vs transient**: adapter-level 4xx/malformed responses return `FAILED` (move to next provider); 5xx/network errors throw (retried with backoff first).
- **Templates are authored, not improvised**: `template_bodies.ts` holds human-authored en/bn bodies per `CommunicationTemplateCode`; strict `{{key}}` interpolation; an unauthored code throws loudly.
- **Interface-only adapters** (`free_framework`, `telegram`, `viber`, `signal`) throw `ProviderNotImplementedError` on send per the Rule 18 exception — documented contract, registry entry, asserting test.

## Gate-Driven Pipeline Lifecycle

The UROS evaluation pipeline is a chain of asynchronous queue jobs connected by human-in-the-loop gates. No stage blocks a worker — each gate creates a durable `PENDING` row and returns; resolution enqueues a `CONTINUE_FROM_GATE` job that resumes the pipeline.

```mermaid
flowchart TD
    INTAKE["stageIntake<br/>IMPORT_APPROVAL gate"]
    PARSE["stageParse"]
    ELIG["stageEligibility<br/>ELIGIBILITY_REVIEW gate"]
    SCORE["stageScoring"]
    REVIEW["stageHumanReview<br/>SHORTLIST_CONFIRMATION gate"]
    VERIFY["stageVerification<br/>VERIFICATION_SIGNOFF gate"]
    COMM["stageCommunication<br/>COMMUNICATION_APPROVAL gate"]
    COMM_EXEC["stageCommunicationExecute"]
    FINAL["stageFinalApproval<br/>FINAL_APPROVAL gate"]
    DONE["Pipeline Complete"]

    INTAKE -->|APPROVE| PARSE
    PARSE --> ELIG
    ELIG -->|APPROVE| SCORE
    SCORE --> REVIEW
    REVIEW -->|APPROVE| VERIFY
    VERIFY -->|APPROVE| COMM
    COMM -->|APPROVE| COMM_EXEC
    COMM_EXEC --> FINAL
    FINAL -->|APPROVE| DONE

    INTAKE -.->|REJECT| STOP1[⊘ Stop]
    ELIG -.->|REJECT| STOP2[⊘ Stop]
    REVIEW -.->|REJECT| REJ1[Candidates → REJECTED]
    VERIFY -.->|REJECT| STOP3[⊘ Stay VERIFIED]
    COMM -.->|REJECT| STOP4[⊘ Stay VERIFIED, audit only]
    FINAL -.->|REJECT| STOP5[⊘ Stay VERIFIED, audit only]

    style INTAKE fill:#D97706,color:#fff
    style ELIG fill:#D97706,color:#fff
    style REVIEW fill:#D97706,color:#fff
    style VERIFY fill:#D97706,color:#fff
    style COMM fill:#D97706,color:#fff
    style FINAL fill:#D97706,color:#fff
```

### Gate Resolution Flow

```mermaid
sequenceDiagram
    participant UI as HIL Gate Inbox
    participant API as POST /gates/:id/resolve
    participant DB as gate_events
    participant Q as evaluation_jobs

    UI->>API: { decision, reason_comment, payload }
    API->>DB: UPDATE gate_events SET status='RESOLVED',<br/>resolved_by_name=<human name>
    API->>Q: INSERT evaluation_jobs<br/>stage='CONTINUE_FROM_GATE'
    API-->>UI: 200 { gate_id, status, decision }
    Q->>Q: Consumer picks up CONTINUE_FROM_GATE
    Q->>Q: continueFromGate() dispatches<br/>to next pipeline stage
```

## Batch Checkpoint Lifecycle

```mermaid
stateDiagram-v2
    [*] --> PENDING: beginBatch()
    PENDING --> RUNNING: first item starts
    RUNNING --> COMPLETED: all items processed
    RUNNING --> FAILED: fatal error + no items succeeded
    RUNNING --> INTERRUPTED: lease expires / process crash
    INTERRUPTED --> RUNNING: resume (new owner claims lease)
    INTERRUPTED --> FAILED: max attempts exceeded
    COMPLETED --> RUNNING: rerunCompleted=true (re-run)
    FAILED --> RUNNING: rerunFailed=true (retry)
```

### Lease & Fencing Token Protocol

```mermaid
sequenceDiagram
    participant W1 as Worker A
    participant DB as agent_batch_progress
    participant W2 as Worker B

    W1->>DB: Claim lease: UPDATE SET owner_id=A,<br/>lease_expires_at=now()+30s,<br/>fencing_token=fencing_token+1
    Note over W1: heartbeat every 10s
    W1->>DB: Heartbeat: UPDATE lease_expires_at
    Note over W1: Process crashes
    Note over DB: lease_expires_at passes
    W2->>DB: Claim lease: WHERE status='RUNNING'<br/>AND lease_expires_at < now()<br/>AND fencing_token < current
    W2->>DB: fencing_token incremented → W1's<br/>writes are rejected (stale token)
```

### Per-Item Checkpoint (O(1) Writes)

```mermaid
flowchart LR
    A["Item 1 starts"] --> B["Item 1 done"]
    B --> C["INSERT INTO<br/>agent_batch_progress_item<br/>(batch_key, item_key, status)"]
    C --> D["Item 2 starts"]
    D --> E["Item 2 fails"]
    E --> F["INSERT INTO<br/>agent_batch_progress_item<br/>(batch_key, item_key, status, error)"]
    
    style C fill:#0F766E,color:#fff
    style F fill:#E2725B,color:#fff
```

Recovery reads `agent_batch_progress_item WHERE batch_key = $1` to rebuild `alreadyProcessedKeys` in O(n) — no JSONB array parsing, no write amplification.
