# UROS API Reference

Base URL: `https://api.uros.gov.bd/api/v1`

## Authentication

All endpoints require a JWT Bearer token in the `Authorization` header.

```
Authorization: Bearer <access_token>
```

### POST /auth/login

Login with email and password.

**Request:**
```json
{ "email": "admin@uros.gov.bd", "password": "Admin@1234" }
```

**Response:**
```json
{ "access_token": "...", "refresh_token": "...", "expires_in": 900 }
```

### POST /auth/refresh

Refresh an expired access token.

**Request:**
```json
{ "refresh_token": "..." }
```

## Candidates

### GET /candidates

List candidates for the authenticated organization.

**Query params:** `page`, `limit`, `status`, `search`

### GET /candidates/:id

Get a single candidate by ID (org-scoped).

### POST /candidates

Create a new candidate.

### PATCH /candidates/:id

Update candidate fields.

### DELETE /candidates/:id

Soft-delete a candidate.

## Intake

### POST /intake/csv

Upload a CSV file for batch candidate import.

**Content-Type:** `multipart/form-data`

### POST /intake/email

Trigger email inbox polling.

### POST /intake/bdjobs

Trigger Bdjobs application import.

### POST /intake/teletalk

Trigger Teletalk CV bank sync.

## Pipeline

### POST /pipeline/eligibility

Run eligibility evaluation on candidates.

### POST /pipeline/scoring

Run dimension scoring on eligible candidates.

### POST /pipeline/ranking

Run ranking on scored candidates.

## HIL Gates

### GET /gates

List gate events (pending or resolved).

**Query params:** `status`, `gate_type`, `page`, `limit`

### POST /gates/:gateId/resolve

Resolve a gate event with a human decision.

**Request:**
```json
{ "decision": "APPROVE", "reason": "Manual review confirmed eligibility", "reason_code": "MANUAL_APPROVE" }
```

## Rule Packs (Brain Studio)

### GET /rule-packs

List all rule packs for the organization.

### POST /rule-packs

Create a new rule pack.

### GET /rule-packs/:id

Get a rule pack with its rules and versions.

### POST /rule-packs/:id/rules

Add a rule to a pack.

### POST /rule-packs/:id/publish

Publish a draft as a new version.

### POST /rule-packs/:id/check-conflicts

Check for rule conflicts within a pack.

### POST /rule-packs/:id/simulate

Run a simulation of draft rules against sample candidates.

## Reports

### GET /reports/preview

Preview report data before download.

**Query params:** `type` (candidates, funnel, source, audit), `format` (json, pdf, xlsx, csv)

### GET /reports/download

Download a generated report.

## Analytics

### GET /analytics/funnel

Recruitment funnel metrics.

### GET /analytics/source

Source effectiveness metrics.

### GET /analytics/timeline

Timeline-based recruitment metrics.

## Settings

### GET /settings/profile

Get organization profile.

### PATCH /settings/profile

Update organization profile.

### GET /settings/credentials

List BYOK API credentials (masked).

### POST /settings/credentials

Add a BYOK API credential.

### POST /settings/backup

Trigger a manual database backup.

### GET /settings/audit

Query audit logs.

## Health

### GET /health

System health check (DB, Redis, queue, encryption).

### GET /api/v1/agent-health

Agent health status for all registered agents.

## Error Responses

All errors follow a consistent format:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Candidate not found",
    "status": 404
  }
}
```

Common status codes:
- `400` — Bad request (validation error)
- `401` — Unauthorized (invalid/expired token)
- `403` — Forbidden (insufficient role)
- `404` — Not found (or cross-org access denied)
- `409` — Conflict (duplicate resource)
- `422` — Unprocessable (business rule violation)
- `429` — Rate limited
- `500` — Internal server error
