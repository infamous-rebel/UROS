-- 0003_candidates.sql
CREATE TABLE candidates (
    candidate_id        TEXT PRIMARY KEY,
    org_id              UUID NOT NULL REFERENCES organizations(org_id),
    full_name           TEXT NOT NULL,
    father_name         TEXT,
    mother_name         TEXT,
    date_of_birth       DATE,
    gender              TEXT CHECK (gender IN ('Male','Female','Third Gender')),
    nationality         TEXT DEFAULT 'Bangladeshi',
    national_id         TEXT,
    phone_primary       TEXT,
    email               TEXT,
    present_address     TEXT,
    permanent_address   TEXT,
    district            TEXT,
    division             TEXT,
    source_platform     TEXT CHECK (source_platform IN
                         ('Teletalk','bdjobs','LinkedIn','Email','WhatsApp','CSV')),
    application_date    TIMESTAMPTZ,
    job_circular_id     TEXT,
    position_applied    TEXT,
    data_confidence     TEXT CHECK (data_confidence IN ('High','Medium','Low')),
    duplicate_of        TEXT REFERENCES candidates(candidate_id),
    status              TEXT NOT NULL DEFAULT 'INTAKE' CHECK (status IN
                         ('INTAKE','PARSED','ELIGIBILITY_DONE','SCORED',
                          'NEEDS_REVIEW','ELIGIBLE_APPROVED','SHORTLISTED',
                          'VERIFIED','REJECTED','SELECTED','WITHDRAWN')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_candidates_org_status ON candidates(org_id, status);
CREATE INDEX idx_candidates_circular ON candidates(job_circular_id);

CREATE TABLE candidate_academic_records (
    record_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id         TEXT NOT NULL REFERENCES candidates(candidate_id),
    level                TEXT CHECK (level IN ('SSC','HSC','Bachelor','Masters','Diploma','Other')),
    institution          TEXT,
    board_or_university  TEXT,
    passing_year         INTEGER,
    division_class       TEXT CHECK (division_class IN ('First','Second','Third','CGPA')),
    cgpa                 NUMERIC(3,2),
    result_scale         TEXT,
    field_confidence     NUMERIC
);
CREATE INDEX idx_academic_candidate ON candidate_academic_records(candidate_id);

CREATE TABLE candidate_experience (
    experience_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id      TEXT NOT NULL REFERENCES candidates(candidate_id),
    organization      TEXT,
    designation       TEXT,
    start_date        DATE,
    end_date          DATE,
    is_current        BOOLEAN DEFAULT false,
    experience_years  NUMERIC(4,1)
);

CREATE TABLE candidate_quota (
    candidate_id             TEXT PRIMARY KEY REFERENCES candidates(candidate_id),
    quota_type               TEXT,
    quota_certificate_no     TEXT,
    quota_issuing_authority  TEXT,
    applied_quota_flag       BOOLEAN DEFAULT false
);

CREATE TABLE candidate_documents (
    doc_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id         TEXT NOT NULL REFERENCES candidates(candidate_id),
    doc_type             TEXT NOT NULL,
    file_location        TEXT NOT NULL,
    ocr_confidence        NUMERIC,
    verification_status   TEXT CHECK (verification_status IN
                           ('Pending','Verified','Failed','Manual Review')) DEFAULT 'Pending',
    verified_by           UUID REFERENCES users(user_id),
    verified_at           TIMESTAMPTZ
);
CREATE INDEX idx_docs_candidate ON candidate_documents(candidate_id);
