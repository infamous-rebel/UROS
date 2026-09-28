CREATE TABLE task_logs (
    task_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        UUID NOT NULL REFERENCES organizations(org_id),
    assignee_id   UUID NOT NULL REFERENCES users(user_id),
    created_by    UUID NOT NULL REFERENCES users(user_id),
    title         TEXT NOT NULL,
    description   TEXT,
    priority      TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH')),
    status        TEXT NOT NULL DEFAULT 'TODO' CHECK (status IN ('TODO','IN_PROGRESS','DONE','BLOCKED')),
    due_date      TIMESTAMPTZ,
    completed_at  TIMESTAMPTZ,
    closure_approved_by UUID REFERENCES users(user_id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_task_logs_org_status ON task_logs(org_id, status);
CREATE INDEX idx_task_logs_assignee ON task_logs(assignee_id, status);
