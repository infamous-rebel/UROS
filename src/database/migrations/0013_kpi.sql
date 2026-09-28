CREATE TABLE kpi_definitions (
    kpi_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES organizations(org_id),
    role        TEXT NOT NULL,
    name        TEXT NOT NULL,
    formula     JSONB NOT NULL, -- [{metric_field, weight}], weights should sum to 100 by convention
    cycle       TEXT NOT NULL DEFAULT 'MONTHLY' CHECK (cycle IN ('MONTHLY','QUARTERLY','ANNUAL')),
    band_thresholds JSONB, -- {"Outstanding":90,"Good":75,"Average":60,"Below Average":0}
    active      BOOLEAN NOT NULL DEFAULT true,
    created_by  UUID REFERENCES users(user_id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE kpi_scores (
    score_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kpi_id           UUID NOT NULL REFERENCES kpi_definitions(kpi_id),
    employee_id      UUID NOT NULL REFERENCES employees(employee_id),
    period           TEXT NOT NULL, -- e.g. '2026-Q3', '2026-08'
    input_metrics    JSONB NOT NULL,
    calculated_score NUMERIC NOT NULL,
    breakdown        JSONB NOT NULL,
    band             TEXT,
    approved_score   NUMERIC,
    reviewer_id      UUID REFERENCES users(user_id),
    status           TEXT NOT NULL DEFAULT 'CALCULATED' CHECK (status IN ('CALCULATED','APPROVED','OVERRIDDEN')),
    override_reason  TEXT,
    calculated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_at      TIMESTAMPTZ,
    UNIQUE (kpi_id, employee_id, period)
);
CREATE INDEX idx_kpi_scores_employee ON kpi_scores(employee_id, period);
