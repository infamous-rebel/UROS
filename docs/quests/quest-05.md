# Quest 05 — Operator UI, Full Auth, Upload/Download, Dark Mode, Documentation

## Overview
Build the complete UROS operator UI with authentication, candidate management, intake panels, Brain Studio rule editor, settings, downloads, navigation redesign, plain language, i18n, HIL gates, E2E tests, documentation, and dark mode.

## Parts

### Part 1: Authentication & Session
- Email + password login (no temp passwords, no bypass)
- PASSWORD_RESET_REQUIRED surfaced as actionable instruction
- Session management with device listing and revoke
- Org switcher with JWT org claim propagation
- Notification bell + global search stubs

### Part 2: Full CommandBar
- Command palette (Cmd+K) with fuzzy search
- Navigation to all tabs via command bar
- Keyboard shortcuts for common actions

### Part 3: Dashboard & Queue Polish
- PipelineStrip with live stage counts and clickable navigation
- DecisionQueue with expandable rows, checkboxes, filter chips, batch actions
- Reason code badges with color coding
- Live empty state with hourly stats

### Part 4: Candidate Views
- CandidateList with filters, pagination, sort, column chooser, CSV export
- CandidateInspector side panel with evaluations, evidence, verification tabs
- POST /candidates/:id/notes endpoint with audit logging

### Part 5: Intake Panels
- Upload CV, import CSV, batch management
- Email intake (Mailpit integration)
- Bdjobs scraper (4 paths) + Teletalk CV Bank
- Webhook handlers with HMAC verification

### Part 6: Brain Studio
- No-code rule pack editor
- RulesList, RulePackEditor, RuleCard, RuleEditor
- ConflictChecker, VersionHistory, SimulationPanel
- PublishButton with reason (min 10 chars)

### Part 7: Settings (12 tabs)
- Profile, Organization, Users, Credentials, Integrations, Permissions
- Audit Log, Retention, Backups, Personas, KPIs, Onboarding Templates
- Each tab with CRUD operations and validation

### Part 8: DownloadButton everywhere
- Every file endpoint has a DownloadButton consumer
- CSV export, report downloads, exam exports

### Part 8b: Navigation redesign
- Left sidebar replacing horizontal tab strip
- navConfig.ts as single source of truth
- Pinned items, collapsed state, localStorage persistence

### Part 8c: Icon system
- iconRegistry.ts mapping string names to Lucide components
- Icon.tsx wrapper component
- No direct lucide-react imports outside wrapper

### Part 8d: Logo integration (DEFERRED)
- UROS logo in sidebar header

### Part 9: Plain Language everywhere
- reasonCodes.ts translation map (108 entries covering all backend codes)
- ReasonCode.tsx badge component with expand/collapse
- PlainError.tsx HTTP status to plain language (400-504)
- Toast.tsx + useToast hook (success/error/warning)
- Skeleton.tsx loading states (5 variants)
- EmptyState.tsx rich empty states with stats + action
- Inline form validation on all auth forms + Settings
- CI guards: no raw reason_code, reason code coverage

### Part 10: Full i18n (en + bn)
- Single source of truth: src/ui/src/i18n/{en,bn}.json
- Every visible string uses t('...')
- Format helpers: formatDate, formatNumber, formatCurrency, formatPhone, formatRelativeTime
- Language switcher with persistence
- RTL scaffold (dir="ltr" now, logical properties for future)
- CI guard: no hardcoded English, every t() key in both files

### Part 11: HIL Gates Polish
- Gate resolution form with reason validation
- Batch gate operations
- Gate audit trail

### Part 12: Playwright E2E
- Full E2E test suite covering auth, candidate flow, intake, Brain Studio
- Screenshot evidence for all critical paths

### Part 13: Documentation
- Architecture docs, runbooks, API reference
- User guides for each feature

### Part 14: Dark Mode
- Dark mode toggle with persistence
- Full dark mode support across all components
- CSS variables for theming

### Checkpoint C: E2E + dark mode verification
- All E2E tests passing
- Dark mode screenshots for all panels

### Parts 15–18: Final verification + close-out
- Performance audit
- Security review
- Accessibility audit
- Production readiness checklist

## Rules
- Rule 19: Checkpoint commit policy
- Rule 20: Push to origin/main after each Part
- Rule 21: Visual evidence must be distinct
- Rule 22: Commit every Quest spec before execution
