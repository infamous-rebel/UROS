CREATE TABLE personas (
    persona_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       UUID NOT NULL REFERENCES organizations(org_id),
    department   TEXT NOT NULL,
    job_family   TEXT NOT NULL,
    name         TEXT NOT NULL,
    version      INTEGER NOT NULL DEFAULT 1,
    active       BOOLEAN NOT NULL DEFAULT true,
    created_by   UUID REFERENCES users(user_id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_personas_org ON personas(org_id, active);

CREATE TABLE persona_requirements (
    requirement_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    persona_id     UUID NOT NULL REFERENCES personas(persona_id),
    field_path     TEXT NOT NULL,
    operator       TEXT NOT NULL CHECK (operator IN ('EQ','NEQ','LT','LTE','GT','GTE','IN','NOT_IN','REGEX')),
    value          JSONB NOT NULL,
    weight         NUMERIC NOT NULL DEFAULT 0
);
CREATE INDEX idx_persona_requirements_persona ON persona_requirements(persona_id);

CREATE TABLE improvement_suggestions (
    suggestion_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        UUID NOT NULL REFERENCES organizations(org_id),
    employee_id   UUID NOT NULL REFERENCES employees(employee_id),
    persona_id    UUID REFERENCES personas(persona_id),
    gap_type      TEXT NOT NULL, -- e.g. KPI_BELOW_TARGET, PERSONA_REQUIREMENT_GAP
    suggestion    TEXT NOT NULL,
    source        TEXT NOT NULL DEFAULT 'DETERMINISTIC' CHECK (source IN ('DETERMINISTIC','LLM_BYOK')),
    status        TEXT NOT NULL DEFAULT 'SUGGESTED'
                   CHECK (status IN ('SUGGESTED','MANAGER_APPROVED','HR_ASSIGNED','COMPLETED','REJECTED')),
    assigned_to   UUID REFERENCES users(user_id),
    reviewed_by   UUID REFERENCES users(user_id),
    reviewed_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_improvement_suggestions_employee ON improvement_suggestions(employee_id, status);
