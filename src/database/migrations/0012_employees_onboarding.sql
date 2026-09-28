CREATE TABLE employees (
    employee_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        UUID NOT NULL REFERENCES organizations(org_id),
    candidate_id  TEXT REFERENCES candidates(candidate_id),
    full_name     TEXT NOT NULL,
    email         TEXT,
    phone         TEXT,
    department    TEXT,
    position      TEXT,
    manager_user_id UUID REFERENCES users(user_id),
    start_date    DATE,
    status        TEXT NOT NULL DEFAULT 'ONBOARDING' CHECK (status IN ('ONBOARDING','ACTIVE','OFFBOARDED')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_employees_org_status ON employees(org_id, status);

CREATE TABLE onboarding_templates (
    template_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(org_id),
    name            TEXT NOT NULL,
    checklist_items JSONB NOT NULL, -- [{item_code,label,category,assigned_role,default_due_days}]
    created_by      UUID REFERENCES users(user_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE onboarding_assignments (
    assignment_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id     UUID NOT NULL REFERENCES employees(employee_id),
    template_id     UUID NOT NULL REFERENCES onboarding_templates(template_id),
    item_code       TEXT NOT NULL,
    label           TEXT NOT NULL,
    assigned_role   TEXT,
    status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','IN_PROGRESS','COMPLETED','OVERDUE')),
    due_date        TIMESTAMPTZ,
    completed_by    UUID REFERENCES users(user_id),
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_onboarding_assignments_employee ON onboarding_assignments(employee_id, status);
