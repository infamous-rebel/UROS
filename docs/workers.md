# UROS Workers

Background workers handle asynchronous, long-running, and scheduled tasks.

## Worker Types

### Queue Consumer

Processes jobs from the Redis BullMQ queue:

- Agent batch execution (eligibility, scoring, ranking)
- Communication dispatch (email, SMS, WhatsApp)
- Report generation
- Document processing

Location: `src/services/queue/consumer.ts`

### Scheduler

Cron-based scheduled tasks:

- **Rediscovery sweep** — weekly scan for re-engageable candidates
- **KPI aggregation** — daily metrics rollup
- **Audit log partition** — monthly partition maintenance
- **Backup trigger** — nightly database backup

Location: `src/services/queue/scheduler.ts`

### Integration Poller

Polls external services for inbound data:

- Email inbox polling (IMAP)
- Bdjobs application feed
- Teletalk CV bank sync
- ATS webhook delivery confirmation

Location: `src/services/integrations/`

## Worker Lifecycle

```
Job enqueued → Queue consumer picks up → Agent executes → Result stored → Audit log written → Next stage triggered
```

## Error Handling

- **Retry** — transient failures retry with exponential backoff (3 attempts)
- **Dead letter** — permanent failures move to dead letter queue
- **Circuit breaker** — repeated failures trip the circuit (5 failures in 60s → 30s cooldown)
- **Rate limiting** — per-provider rate limits enforced before dispatch

## Scaling

Workers scale horizontally via Cloud Run concurrent instances. Each instance:
- Pulls from the same Redis queue
- Processes jobs independently (no shared state)
- Reports health via `/health` endpoint

## Monitoring

- Agent health endpoint: `GET /api/v1/agent-health`
- Queue metrics: pending, active, completed, failed counts
- Dead letter queue alerting via communication dispatcher
