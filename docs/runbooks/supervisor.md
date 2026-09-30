# Supervisor Runbook

The HIL (Human-in-the-Loop) Supervisor manages gate events that require human review before candidates can proceed in the pipeline.

## Overview

```
Candidate processed by agent → Gate event created (PENDING) →
  Human reviewer opens HIL Gate Inbox → Reviews evidence →
  Resolves with APPROVE/REJECT + reason → Candidate proceeds/stops
```

## Gate Types

| Gate Type | Trigger | Default Timeout |
|-----------|---------|-----------------|
| ELIGIBILITY_REVIEW | Borderline eligibility score | 48 hours |
| FRAUD_ALERT | Fraud detection agent flagged inconsistency | 24 hours |
| REFERENCE_MISMATCH | Reference check discrepancy | 72 hours |
| SCORE_ANOMALY | Unusual scoring pattern | 48 hours |
| DOCUMENT_QUALITY | Low OCR confidence | 24 hours |

## HIL Gate Inbox

### Accessing the Inbox

1. Login to UROS
2. Navigate to **HIL Gates** in the sidebar (under RECRUITMENT)
3. The inbox shows pending gates with candidate IDs and gate types

### Resolving a Gate

1. Click on a gate event to expand it
2. Review the evidence (candidate data, agent output, reason codes)
3. Select decision: **APPROVE** or **REJECT**
4. Enter a reason (minimum 10 characters)
5. Click **Resolve**
6. The gate status changes to RESOLVED and the candidate proceeds/stops

### Batch Operations

- Select multiple gates with checkboxes
- **Batch Approve** — approve all selected with a shared reason
- **Batch Reject** — reject all selected with a shared reason
- Keyboard shortcuts: `j`/`k` to navigate, `Space` to select, `a` to approve, `r` to reject

## Monitoring

### Gate Metrics

```bash
# Count pending gates
curl -H "Authorization: Bearer $TOKEN" \
  "https://api.uros.gov.bd/api/v1/gates?status=PENDING" | jq '.total'

# Count gates by type
curl -H "Authorization: Bearer $TOKEN" \
  "https://api.uros.gov.bd/api/v1/gates?status=PENDING" | jq '[.gates[].gate_type] | group_by(.) | map({type: .[0], count: length})'
```

### SLA Alerts

Gates approaching timeout should trigger alerts:
- 80% of timeout → warning notification to reviewer
- 100% of timeout → escalation to admin
- 150% of timeout → critical alert to system operator

### Audit Trail

Every gate resolution is logged:
- Who resolved it (user email)
- When (timestamp)
- Decision (APPROVE/REJECT)
- Reason (human-readable text)
- Reason code (machine-readable)

View in the **Audit** tab or via API:
```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://api.uros.gov.bd/api/v1/settings/audit?entity=gate_event"
```

## Troubleshooting

### Gate stuck in PENDING

1. Check if the gate event exists in the database
2. Verify the candidate is in the correct state
3. Check for concurrent resolution attempts

### Gate resolved but candidate not advancing

1. Check the orchestrator queue — the next stage job may be stuck
2. Verify the candidate's current status
3. Re-trigger the pipeline stage manually if needed

### Batch resolve not working

1. Ensure all selected gates are in PENDING status
2. Check for permission issues (ADMIN role required for batch operations)
3. Verify the reason meets minimum length requirement (10 characters)
