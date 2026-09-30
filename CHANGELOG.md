# Changelog

All notable changes to UROS are documented in this file.

## [Unreleased] — Quest 05: Operator UI, Full Auth, i18n, E2E

### Added
- Full authentication flow: login, JWT access + refresh tokens, 401 auto-refresh
- Operator UI with 22 panels across 6 nav groups (Recruitment, Assessment, Quality, People, Analytics, Admin)
- i18n support: English + Bangla (890+ translation keys, parity-verified)
- Language switcher (English ↔ বাংলা) with localStorage persistence
- Navigation: sidebar with 6 groups, breadcrumbs, command palette (Cmd+K), collapse/expand
- HIL Gate Inbox: batch operations, keyboard navigation, audit trail, resolve with reason
- Brain Studio: no-code rule pack editor with conflict detection, version history, simulation
- Settings: 12 sub-tabs (Profile, Credentials/BYOK, SMS Fallback, Backup, Audit, Data Export, etc.)
- Report Generator: PDF/Excel/CSV download with preview
- Playwright E2E: 10 test suites, 36 tests, all passing
- CI split: `e2e-fast` (headless, every PR) + `e2e-evidence` (headed, screenshots, nightly)
- 30 curated E2E screenshots as visual evidence

### Changed
- Migrated UI from hardcoded English to full i18n with t() calls across all panels
- Playwright webServer config: array with both API (:3000) and UI (:5173)

## [0.4.0] — Quest 04: Communication Integrations

### Added
- 30 communication connectors (email, SMS, WhatsApp, LinkedIn, Calendar, etc.)
- Dispatcher with fallback chain, rate limiting, circuit breaker, retry
- Import batches with idempotent re-ingest guard
- WhatsApp template management
- Communication log with provider tracking

## [0.3.0] — Quest 03: Pipeline Wiring

### Added
- Pipeline orchestration: intake → eligibility → scoring → ranking → HIL gates
- Gate events with PENDING/RESOLVED status and reason codes
- Candidate state machine
- Queue-based agent execution

## [0.2.0] — Quest 02: Audit & Tenant Isolation

### Added
- Audit log with partitioning (RANGE by month)
- Tenant isolation guard: cross-org requests return 404
- Appeal triage with org-scoped access control

## [0.1.0] — Quest 01: Foundation

### Added
- Postgres + Redis infrastructure
- 24 agents (Intake, Parser, Eligibility, Scoring, Ranking, Verification, etc.)
- Rule engine with deterministic evaluation
- API server with JWT auth
- Basic UI dashboard
- Docker Compose for local development
- CI/CD with GitHub Actions
