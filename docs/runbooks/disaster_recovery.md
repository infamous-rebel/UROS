# Disaster Recovery Runbook

## Recovery Objectives

| Metric | Target |
|--------|--------|
| RPO (Recovery Point Objective) | 1 hour |
| RTO (Recovery Time Objective) | 4 hours |
| Backup frequency | Nightly (automated) + hourly WAL archiving |
| Backup retention | 30 days |
| Geo-redundancy | Multi-region (GCS dual-region bucket) |

## Backup Architecture

```
Postgres (primary) → WAL archiving → GCS bucket (hourly)
                → pg_dump nightly → GCS bucket (nightly)
Redis → RDB snapshot → GCS bucket (nightly)
```

## Recovery Procedures

### Scenario 1: Database Corruption

1. **Stop the API** — prevent writes to corrupted DB
   ```bash
   kubectl scale deployment uros-api --replicas=0
   ```

2. **Identify the latest good backup**
   ```bash
   gsutil ls gs://uros-backs/db/ | sort -r | head -5
   ```

3. **Restore from backup**
   ```bash
   ./scripts/restore.sh <backup-file>
   ```

4. **Verify data integrity**
   ```bash
   psql $DATABASE_URL -c "SELECT count(*) FROM candidates;"
   psql $DATABASE_URL -c "SELECT count(*) FROM audit_log;"
   ```

5. **Restart the API**
   ```bash
   kubectl scale deployment uros-api --replicas=2
   ```

6. **Verify health**
   ```bash
   curl https://api.uros.gov.bd/health
   ```

### Scenario 2: Complete Region Failure

1. **Activate DR region**
   ```bash
   gcloud run services update uros-api --region=us-central1
   ```

2. **Restore database from GCS backup**
   ```bash
   ./scripts/restore.sh gs://uros-backs-dr/db/latest.dump
   ```

3. **Update DNS**
   ```bash
   # Cloudflare: switch origin to DR region
   ```

4. **Verify all services**
   ```bash
   curl https://api.uros.gov.bd/health
   ```

### Scenario 3: Redis Data Loss

Redis is used for queue state only. Data is recoverable:

1. **Flush and restart Redis**
   ```bash
   docker restart fielded-redis
   ```

2. **Re-enqueue pending jobs**
   ```bash
   # The orchestrator will detect candidates in non-terminal states
   # without corresponding queue jobs and re-enqueue them
   ```

3. **Verify queue health**
   ```bash
   curl https://api.uros.gov.bd/health | jq '.checks.queue'
   ```

### Scenario 4: Document Storage Failure

1. **Switch to local storage temporarily**
   ```bash
   export DOCUMENT_STORAGE=local
   ```

2. **Investigate GCS issue**
   ```bash
   gsutil ls gs://uros-documents/
   ```

3. **Restore access and switch back**
   ```bash
   export DOCUMENT_STORAGE=gcs
   ```

## Post-Recovery Checklist

- [ ] Health endpoint returns all checks "ok"
- [ ] Candidate count matches expected
- [ ] Audit log is intact
- [ ] Queue is processing jobs
- [ ] E2E smoke test passes
- [ ] Notify affected organizations
- [ ] Write incident report within 14 days

## Contact

- On-call engineer: see PagerDuty rotation
- Database admin: dba@uros.gov.bd
- Infrastructure: infra@uros.gov.bd
