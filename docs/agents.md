# UROS Agents

Every agent is a deterministic, testable unit of work. No black-box AI — every decision is traceable to a human-defined, versioned rule.

## Agent Inventory

| Agent | Directory | Responsibility |
|-------|-----------|----------------|
| Intake | `src/agents/intake_agent/` | CV parsing, CSV import, email/bdjobs/teletalk ingestion |
| Parser | `src/agents/parser_agent/` | Structured data extraction from unstructured documents |
| Eligibility | `src/agents/eligibility_agent/` | Rule-based eligibility evaluation |
| Scoring | `src/agents/scoring_agent/` | Candidate scoring against dimension weights |
| Dimension Scoring | `src/agents/dimension_scoring_agent/` | 7-dimension matching scores |
| Ranking | `src/agents/ranking_agent/` | Composite ranking with knockout logic |
| Verification | `src/agents/verification_agent/` | Document and credential verification |
| Fraud Detection | `src/agents/fraud_detection_agent/` | Inconsistency and anomaly detection |
| Reference Check | `src/agents/reference_check_agent/` | Automated reference collection |
| Exam Scanner | `src/agents/exam_scanner_agent/` | MCQ answer sheet OCR processing |
| Digital Exam | `src/agents/digital_exam_agent/` | Digital exam paper management |
| Communication | `src/agents/communication_agent/` | Candidate notification dispatch |
| Appeal Triage | `src/agents/appeal_triage_agent/` | Candidate appeal classification |
| Applicant Portal | `src/agents/applicant_portal_agent/` | Self-service applicant portal |
| Audit | `src/agents/audit_agent/` | Audit log aggregation and analysis |
| HIL Supervisor | `src/agents/hil_supervisor_agent/` | Human-in-the-loop gate management |
| KPI | `src/agents/kpi_agent/` | Process performance metrics |
| Persona | `src/agents/persona_agent/` | Departmental persona generation |
| Improvement Advisor | `src/agents/improvement_advisor_agent/` | Process improvement recommendations |
| Onboarding | `src/agents/onboarding_agent/` | New hire onboarding workflow |
| Offboarding | `src/agents/offboarding_agent/` | Exit management |
| Recruitment Analytics | `src/agents/recruitment_analytics_agent/` | Funnel and source analytics |
| Rediscovery | `src/agents/rediscovery_agent/` | Talent pool re-engagement |
| Report | `src/agents/report_agent/` | Report generation (PDF/Excel/CSV) |
| Task Log | `src/agents/task_log_agent/` | Task tracking and logging |

## Agent Contract

Every agent must:

1. Accept a typed input payload
2. Produce a typed output with `reason_code`, `reason_description`, `evidence`
3. Write an `audit_log` row with actor, timestamp, before/after state
4. Be deterministic — same input → same output (given same rule versions)
5. Be testable in isolation with fake DB helpers

## Agent Runner

Agents are executed via the agent runner service (`src/services/agent_runner/`):

- **Single mode** — one agent, one candidate
- **Batch mode** — one agent, many candidates (queue-based)
- **Pipeline mode** — sequential agent chain with gate events

## LLM Integration

LLM (Groq API) is optional and supplementary. Agents use deterministic rules first. LLM is only invoked for:
- Unstructured text extraction (with deterministic fallback)
- Improvement recommendations (advisory only, no enforcement)
- BYOK (Bring Your Own Key) for organization-specific LLM usage
