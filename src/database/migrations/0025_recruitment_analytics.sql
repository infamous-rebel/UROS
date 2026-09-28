-- Feature 8: Recruitment Analytics & Source Effectiveness
--
-- Read-only analytics over existing candidate / evaluation_results /
-- scoring_results / communication_log data, plus two small new tables
-- that hold org-configurable inputs the analytics agent cannot derive
-- from existing tables: what counts as a "quality hire", and what each
-- source/campaign cost. Analytics never writes a decision anywhere;
-- see src/agents/recruitment_analytics_agent/index.ts.
--
-- Tables (per spec):
--   recruitment_analytics_configs - one row per org (upserted via
--     POST /api/v1/analytics/configure), holding the quality-hire
--     definition and default reporting time window.
--   recruitment_source_costs      - one row per (source/campaign,
--     effective_date) cost entry, used to compute cost-per-quality-hire.

-- ---------------------------------------------------------------------
-- recruitment_analytics_configs
-- ---------------------------------------------------------------------
CREATE TABLE recruitment_analytics_configs (
    config_id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                     UUID NOT NULL UNIQUE REFERENCES organizations(org_id),
    -- Shape (see recruitment_analytics.model.ts QualityHireDefinition):
    --   {
    --     "hire_statuses": ["SELECTED"],
    --     "min_score": 65 | null,
    --     "thresholds": {
    --       "min_pass_rate": 0.05,
    --       "min_selection_rate": 0.001,
    --       "max_cost_per_quality_hire": 50000
    --     }
    --   }
    -- One JSONB column per the literal spec; thresholds are nested
    -- inside it rather than adding new columns, and are fully
    -- org-overridable. Documented, not implicit.
    quality_hire_definition   JSONB NOT NULL,
    default_time_window_days INTEGER NOT NULL DEFAULT 90 CHECK (default_time_window_days > 0),
    created_by                UUID REFERENCES users(user_id),
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT recruitment_analytics_configs_definition_is_object
        CHECK (jsonb_typeof(quality_hire_definition) = 'object')
);

CREATE INDEX idx_recruitment_analytics_configs_org ON recruitment_analytics_configs(org_id);

-- ---------------------------------------------------------------------
-- recruitment_source_costs
-- ---------------------------------------------------------------------
CREATE TABLE recruitment_source_costs (
    cost_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(org_id),
    source_platform TEXT NOT NULL CHECK (source_platform IN
                     ('Teletalk','bdjobs','LinkedIn','Email','WhatsApp','CSV')),
    campaign_id     TEXT,
    cost            NUMERIC NOT NULL CHECK (cost >= 0),
    effective_date  DATE NOT NULL,
    created_by      UUID REFERENCES users(user_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_recruitment_source_costs_org_source ON recruitment_source_costs(org_id, source_platform);
CREATE INDEX idx_recruitment_source_costs_org_campaign ON recruitment_source_costs(org_id, campaign_id);
CREATE INDEX idx_recruitment_source_costs_effective_date ON recruitment_source_costs(org_id, effective_date);
