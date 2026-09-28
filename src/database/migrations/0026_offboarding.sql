-- Feature 9: Offboarding & Exit Management
--
-- Mirrors the onboarding module's template -> instantiated-steps pattern
-- (0012_employees_onboarding.sql: onboarding_templates -> onboarding_assignments)
-- with the human-in-the-loop closure step onboarding does not have:
-- every offboarding_steps row can only be marked APPROVED/REJECTED by a
-- human reviewer, never by the assignee alone and never automatically
-- (UROS_Global_Reasoning_Standard.md: "No result may exist without
-- reasoning" / Core Principle: Human-in-the-Loop).
--
-- Tables (per spec): offboarding_templates, offboarding_cases,
-- offboarding_steps.
--
-- Additive column beyond the literal spec, documented: offboarding_steps
-- gets an `item_code` column alongside `title`. Without it, re-deriving
-- which template checklist entry a given step came from (needed for
-- idempotent case creation and for the "template expansion" unit tests)
-- would require string-matching on `title`, which is fragile once an
-- admin edits step wording. `item_code` is the stable, machine-readable
-- key; `title` remains the human-readable label shown in the UI. This
-- mirrors onboarding_assignments.item_code / onboarding_templates
-- checklist_items[].item_code exactly.

-- ---------------------------------------------------------------------
-- offboarding_templates
-- ---------------------------------------------------------------------
CREATE TABLE offboarding_templates (
    template_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        UUID NOT NULL REFERENCES organizations(org_id),
    role          TEXT NOT NULL,
    -- Array of {item_code, title, category?, default_assignee_user_id?,
    -- default_due_days_from_exit?}. default_due_days_from_exit is an
    -- offset relative to offboarding_cases.exit_date (negative = must be
    -- done before the exit date, e.g. "return laptop" at -3; positive =
    -- may be completed after, e.g. "final settlement" at +7). This
    -- anchors due dates to the known exit date rather than case-creation
    -- time, unlike onboarding_assignments (which has no fixed end date
    -- to anchor to).
    checklist     JSONB NOT NULL,
    created_by    UUID REFERENCES users(user_id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT offboarding_templates_checklist_not_empty
        CHECK (jsonb_typeof(checklist) = 'array' AND jsonb_array_length(checklist) > 0)
);

CREATE INDEX idx_offboarding_templates_org_role ON offboarding_templates(org_id, role);

-- ---------------------------------------------------------------------
-- offboarding_cases
-- ---------------------------------------------------------------------
CREATE TABLE offboarding_cases (
    case_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        UUID NOT NULL REFERENCES organizations(org_id),
    employee_id   UUID NOT NULL REFERENCES employees(employee_id),
    template_id   UUID NOT NULL REFERENCES offboarding_templates(template_id),
    status        TEXT NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE','COMPLETED','CANCELLED')),
    exit_date     DATE NOT NULL,
    created_by    UUID REFERENCES users(user_id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Exactly one ACTIVE offboarding case per employee at a time — prevents
-- a duplicate/competing checklist being started for the same person.
CREATE UNIQUE INDEX idx_offboarding_cases_one_active_per_employee
    ON offboarding_cases(employee_id) WHERE status = 'ACTIVE';

CREATE INDEX idx_offboarding_cases_org_status ON offboarding_cases(org_id, status);
CREATE INDEX idx_offboarding_cases_employee ON offboarding_cases(employee_id);

-- ---------------------------------------------------------------------
-- offboarding_steps
-- ---------------------------------------------------------------------
CREATE TABLE offboarding_steps (
    step_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id           UUID NOT NULL REFERENCES offboarding_cases(case_id),
    item_code         TEXT NOT NULL,
    title             TEXT NOT NULL,
    category          TEXT,
    assigned_to       UUID REFERENCES users(user_id),
    status            TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','IN_PROGRESS','COMPLETED','APPROVED','REJECTED','OVERDUE')),
    due_date          TIMESTAMPTZ,
    completed_at      TIMESTAMPTZ,
    -- The human who most recently approved or rejected this step's
    -- closure. Never set by the agent — only via the mandatory-reason
    -- PATCH /offboarding/steps/:step_id APPROVE/REJECT actions.
    approved_by       UUID REFERENCES users(user_id),
    -- Mandatory human-readable reason for the approval/rejection decision
    -- (UROS_Global_Reasoning_Standard.md reason_description). The
    -- machine-readable reason_code and supporting evidence for this row
    -- are recorded inside `evidence` (see offboarding_agent) and, per
    -- every UROS agent, duplicated into the immutable audit_log via
    -- logAudit() — this column is the human-facing half.
    approval_reason   TEXT,
    evidence          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT offboarding_steps_unique_item_per_case UNIQUE (case_id, item_code),
    CONSTRAINT offboarding_steps_approval_requires_reason
        CHECK (status NOT IN ('APPROVED','REJECTED') OR (approval_reason IS NOT NULL AND length(trim(approval_reason)) > 0))
);

-- offboarding_steps intentionally has no org_id column, mirroring
-- onboarding_assignments (0012). Security Hardening Round lesson learned
-- on that exact table (see onboarding.routes.ts comments): every query
-- and update against offboarding_steps in offboarding_agent/routes MUST
-- join through offboarding_cases.org_id — never trust step_id alone.
CREATE INDEX idx_offboarding_steps_case ON offboarding_steps(case_id, status);
CREATE INDEX idx_offboarding_steps_assignee ON offboarding_steps(assigned_to, status);
CREATE INDEX idx_offboarding_steps_due ON offboarding_steps(due_date) WHERE status IN ('PENDING','IN_PROGRESS');
