# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.5.x (Quest 05) | ✅ |
| < 0.5.0 | ❌ |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email: security@uros.gov.bd

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge receipt within 48 hours and provide a detailed response within 5 business days.

## Security Architecture

- **Authentication**: bcrypt password hashing (cost 12), JWT access + refresh tokens
- **Authorization**: RBAC (ADMIN, RECRUITER, AUDITOR, VIEWER), org-scoped tenant isolation
- **Encryption**: AES-256-GCM for document encryption at rest
- **Transport**: TLS 1.3 in production (enforced by Cloud Run / Cloudflare)
- **Multi-tenancy**: Every query filters by `org_id`; cross-org access returns 404
- **Audit**: Every state change logged with actor, timestamp, before/after state
- **Secrets**: Google Secret Manager in production; `.env` in development only

## Dependency Scanning

Dependabot is enabled for npm dependencies. Security advisories are reviewed weekly.

## Penetration Testing

Conducted quarterly by independent security auditors. Reports available upon request to authorized personnel.
