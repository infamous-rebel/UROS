-- 0001_orgs_users.sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organizations (
    org_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    sector          TEXT NOT NULL CHECK (sector IN
                    ('GOVT_NONCADRE','BCS','STATE_BANK','PRIVATE_BANK',
                     'CORPORATE','NGO','SME')),
    deployment_mode TEXT NOT NULL CHECK (deployment_mode IN ('ON_PREM','CLOUD','HYBRID')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
    user_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES organizations(org_id),
    full_name   TEXT NOT NULL,
    email       TEXT UNIQUE,
    role        TEXT NOT NULL CHECK (role IN
                ('ADMIN','RECRUITER','SENIOR_RECRUITER','AUDITOR',
                 'DEPT_HEAD','APPLICANT','SYSTEM_AGENT')),
    dept_scope  TEXT,
    active      BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
