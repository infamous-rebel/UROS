# Compliance

UROS is designed for Bangladesh government recruitment compliance.

## Regulatory Framework

- **Bangladesh Constitution** — Articles 29, 133 (public employment principles)
- **BPSC Regulations** — Bangladesh Public Service Commission rules
- **Digital Bangladesh** — Digital government service delivery standards
- **Data Protection** — Personal data handling per government directives

## Compliance Features

### Audit Trail

Every state change is logged:
- Actor (user or agent)
- Timestamp (UTC, ISO 8601)
- Before/after state (JSON diff)
- Reason code (human-readable)

Audit logs are partitioned by month for efficient querying and retention management.

### Tenant Isolation

- Every database query includes `org_id` filtering
- Cross-org access returns 404 (not 403 — prevents enumeration)
- JWT tokens are org-scoped
- API credentials are org-scoped

### Data Retention

- Candidate data: configurable per organization (default 7 years)
- Audit logs: 10 years (government requirement)
- Documents: encrypted at rest, auto-purge after retention period
- Backup: nightly, 30-day retention, geo-redundant

### Access Control

- RBAC: ADMIN, RECRUITER, AUDITOR, VIEWER
- Minimum privilege principle
- Session timeout: 15 minutes idle
- Password policy: minimum 12 characters, complexity requirements
- MFA: planned for next release

### Transparency

- Every rejection includes a reason code translatable to human-readable text
- Candidates can view their evaluation results via the applicant portal
- Appeal process is built into the system
- All rules are versioned and auditable

## Certification Roadmap

| Standard | Status | Target |
|----------|--------|--------|
| ISO 27001 | Planned | Q2 2027 |
| SOC 2 Type II | Planned | Q3 2027 |
| Bangladesh Digital Security Act | Compliant by design | Ongoing |

## Incident Response

1. Detection — automated alerts + manual reporting
2. Containment — isolate affected systems within 1 hour
3. Investigation — forensic analysis within 24 hours
4. Notification — affected organizations within 48 hours
5. Remediation — patch and deploy within 72 hours
6. Post-mortem — published within 14 days
