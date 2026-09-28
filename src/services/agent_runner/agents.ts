/**
 * Registration of every existing UROS agent with the generic runner.
 *
 * This file contains **no business logic**. Each entry is a one-line
 * delegation to the agent function that already exists in `src/agents/**`;
 * the runner supplies timeout, retry, circuit breaking, logging, audit and
 * metrics around it. Adding a new agent therefore costs one entry here and
 * nothing else — resilience is inherited, not re-implemented.
 *
 * Names are namespaced `<agent>.<operation>` and frozen in `AGENT_NAMES`
 * so callers reference a stable identifier instead of a module path. That
 * indirection is also the seam where a different multi-agent stack could be
 * substituted later: swap the handler, keep the name, and every caller,
 * dashboard, metric label and audit entry continues to work unchanged.
 */
import * as intakeAgent from "../../agents/intake_agent";
import * as parserAgent from "../../agents/parser_agent";
import * as eligibilityAgent from "../../agents/eligibility_agent";
import * as scoringAgent from "../../agents/scoring_agent";
import * as rankingAgent from "../../agents/ranking_agent";
import * as hilSupervisorAgent from "../../agents/hil_supervisor_agent";
import * as verificationAgent from "../../agents/verification_agent";
import * as communicationAgent from "../../agents/communication_agent";
import * as dimensionScoringAgent from "../../agents/dimension_scoring_agent";
import * as examScannerAgent from "../../agents/exam_scanner_agent";
import * as digitalExamAgent from "../../agents/digital_exam_agent";
import * as fraudDetectionAgent from "../../agents/fraud_detection_agent";
import * as referenceCheckAgent from "../../agents/reference_check_agent";
import * as analyticsAgent from "../../agents/recruitment_analytics_agent";
import * as rediscoveryAgent from "../../agents/rediscovery_agent";
import * as personaAgent from "../../agents/persona_agent";
import * as kpiAgent from "../../agents/kpi_agent";
import * as improvementAdvisorAgent from "../../agents/improvement_advisor_agent";
import * as reportAgent from "../../agents/report_agent";
import * as auditAgent from "../../agents/audit_agent";
import * as taskLogAgent from "../../agents/task_log_agent";
import * as onboardingAgent from "../../agents/onboarding_agent";
import * as offboardingAgent from "../../agents/offboarding_agent";
import * as appealTriageAgent from "../../agents/appeal_triage_agent";
import * as applicantPortalAgent from "../../agents/applicant_portal_agent";

import { registerAgents } from "./registry";
import { AgentInvocationContext, AgentRegistration } from "./types";
import { runAgent } from "./runner";

/** Stable, frozen agent-operation names. Callers use these, never string literals. */
export const AGENT_NAMES = {
  INTAKE_FETCH_BATCH: "intake.fetch_batch",
  INTAKE_LOAD_CANDIDATES: "intake.load_candidates",
  PARSER_EXTRACT_FIELDS: "parser.extract_fields",
  PARSER_PERSIST_CANDIDATE: "parser.persist_candidate",
  ELIGIBILITY_RUN_FOR_CANDIDATE: "eligibility.run_for_candidate",
  ELIGIBILITY_RUN_FOR_CIRCULAR: "eligibility.run_for_circular",
  SCORING_COMPUTE: "scoring.compute",
  RANKING_RANK_AND_DEDUPE: "ranking.rank_and_dedupe",
  DIMENSION_SCORING_RUN: "dimension_scoring.run",
  EXAM_SCANNER_DETECT_SHEET: "exam_scanner.detect_sheet",
  EXAM_SCANNER_PROCESS_SHEET: "exam_scanner.process_sheet",
  EXAM_SCANNER_INGEST_FILE: "exam_scanner.ingest_file",
  DIGITAL_EXAM_SCORE_SUBMISSION: "digital_exam.score_submission",
  DIGITAL_EXAM_PARSE_PAPER: "digital_exam.parse_paper",
  DIGITAL_EXAM_PUBLISH: "digital_exam.publish",
  VERIFICATION_CHECK: "verification.check",
  FRAUD_DETECTION_FOR_CANDIDATE: "fraud_detection.for_candidate",
  FRAUD_DETECTION_BATCH: "fraud_detection.batch",
  REFERENCE_CHECK_CREATE_REQUEST: "reference_check.create_request",
  REFERENCE_CHECK_SUBMIT_RESPONSES: "reference_check.submit_responses",
  REFERENCE_CHECK_RUN_SCORING: "reference_check.run_scoring",
  COMMUNICATION_SEND_BATCH: "communication.send_batch",
  REDISCOVERY_RUN_MATCH: "rediscovery.run_match",
  REDISCOVERY_SEND_OUTREACH: "rediscovery.send_outreach",
  ANALYTICS_SOURCE_EFFECTIVENESS: "analytics.source_effectiveness",
  ANALYTICS_FUNNEL: "analytics.funnel",
  ANALYTICS_QUALITY_HIRE: "analytics.quality_hire",
  PERSONA_EVALUATE_FOR_EMPLOYEE: "persona.evaluate_for_employee",
  KPI_CALCULATE_AND_STORE: "kpi.calculate_and_store",
  IMPROVEMENT_ADVISOR_IDENTIFY_GAPS: "improvement_advisor.identify_gaps",
  REPORT_GENERATE: "report.generate",
  AUDIT_FETCH_TRAIL: "audit.fetch_trail",
  AUDIT_CHECK_CONSISTENCY: "audit.check_consistency",
  TASK_LOG_FLAG_OVERDUE: "task_log.flag_overdue",
  TASK_LOG_SEND_REMINDERS: "task_log.send_reminders",
  ONBOARDING_CREATE_ASSIGNMENTS: "onboarding.create_assignments",
  ONBOARDING_FLAG_OVERDUE: "onboarding.flag_overdue",
  OFFBOARDING_FLAG_OVERDUE_STEPS: "offboarding.flag_overdue_steps",
  OFFBOARDING_SEND_STEP_REMINDERS: "offboarding.send_step_reminders",
  APPEAL_TRIAGE_RUN: "appeal_triage.run",
  APPLICANT_PORTAL_STATUS_VIEW: "applicant_portal.status_view",
  HIL_SUPERVISOR_ENQUEUE_REVIEW: "hil_supervisor.enqueue_review",
  HIL_SUPERVISOR_BUILD_REVIEW_QUEUE: "hil_supervisor.build_review_queue",
} as const;

export type AgentName = (typeof AGENT_NAMES)[keyof typeof AGENT_NAMES];

/**
 * Every registration. Handlers are pure delegations — if an agent's
 * signature changes, only this line changes.
 *
 * Timeout overrides are applied only where the default (AGENT_TIMEOUT_MS,
 * 30s) is genuinely wrong for the work: OCR and image decode are CPU-bound
 * and legitimately slow, so they get a longer ceiling rather than being
 * retried into a loop that will fail the same way again.
 */
export const AGENT_REGISTRATIONS: AgentRegistration<any, any>[] = [
  // ---- intake ----
  {
    name: AGENT_NAMES.INTAKE_FETCH_BATCH,
    agent_class: "intake",
    handler: (i: { batch_id: string; org_id: string }) => intakeAgent.fetchBatch(i.batch_id, i.org_id),
  },
  {
    name: AGENT_NAMES.INTAKE_LOAD_CANDIDATES,
    agent_class: "intake",
    handler: (i: { batch: Parameters<typeof intakeAgent.loadCandidates>[0] }) => intakeAgent.loadCandidates(i.batch),
  },

  // ---- parser (OCR / document extraction: CPU-bound, long ceiling) ----
  {
    name: AGENT_NAMES.PARSER_EXTRACT_FIELDS,
    agent_class: "parser",
    handler: (i: { document: parserAgent.RawApplicationDocument }) => parserAgent.extractFields(i.document),
    options: { timeout_ms: 120_000, max_retries: 1 },
  },
  {
    name: AGENT_NAMES.PARSER_PERSIST_CANDIDATE,
    agent_class: "parser",
    handler: (i: { candidate: parserAgent.ParsedCandidate }) => parserAgent.persistCandidate(i.candidate),
  },

  // ---- eligibility / scoring / ranking ----
  {
    name: AGENT_NAMES.ELIGIBILITY_RUN_FOR_CANDIDATE,
    agent_class: "scoring",
    handler: (i: { candidate: any; rule_pack_version_id: string; actor?: string }) =>
      eligibilityAgent.runEligibility(i.candidate, i.rule_pack_version_id, i.actor ?? "EligibilityAgent"),
  },
  {
    name: AGENT_NAMES.ELIGIBILITY_RUN_FOR_CIRCULAR,
    agent_class: "scoring",
    handler: (i: { circular_id: string; rule_pack_version_id: string; actor?: string }) =>
      eligibilityAgent.runEligibilityForCircular(i.circular_id, i.rule_pack_version_id, i.actor ?? "EligibilityAgent"),
    options: { timeout_ms: 300_000 },
  },
  {
    name: AGENT_NAMES.SCORING_COMPUTE,
    agent_class: "scoring",
    handler: (i: { candidate: any; rules: any[] }) => scoringAgent.compute(i.candidate, i.rules),
  },
  {
    name: AGENT_NAMES.RANKING_RANK_AND_DEDUPE,
    agent_class: "scoring",
    handler: (i: { batch_id: string; org_id: string }) => rankingAgent.rankAndDedupe(i.batch_id, i.org_id),
    options: { timeout_ms: 120_000 },
  },
  {
    name: AGENT_NAMES.DIMENSION_SCORING_RUN,
    agent_class: "scoring",
    handler: (i: { candidate_id: string; org_id: string; persona_id: string | null; actor_user_id: string }) =>
      dimensionScoringAgent.runDimensionScoring(i.candidate_id, i.org_id, i.persona_id, i.actor_user_id),
  },
  {
    name: AGENT_NAMES.PERSONA_EVALUATE_FOR_EMPLOYEE,
    agent_class: "scoring",
    handler: (i: { persona_id: string; employee_id: string; profile: Record<string, unknown>; org_id: string; actor_user_id: string }) =>
      personaAgent.evaluatePersonaForEmployee(i.persona_id, i.employee_id, i.profile, i.org_id, i.actor_user_id),
  },

  // ---- scanner (image decode + OMR: CPU-bound, long ceiling) ----
  {
    name: AGENT_NAMES.EXAM_SCANNER_DETECT_SHEET,
    agent_class: "scanner",
    handler: (i: { buffer: Buffer; template: any }) => examScannerAgent.detectSheet(i.buffer, i.template),
    options: { timeout_ms: 120_000, max_retries: 1 },
  },
  {
    name: AGENT_NAMES.EXAM_SCANNER_PROCESS_SHEET,
    agent_class: "scanner",
    handler: (i: { sheet_id: string; actor_user_id: string }) =>
      examScannerAgent.processSheet(i.sheet_id, i.actor_user_id),
    options: { timeout_ms: 120_000, max_retries: 1 },
  },
  {
    name: AGENT_NAMES.EXAM_SCANNER_INGEST_FILE,
    agent_class: "scanner",
    handler: (i: { exam_id: string; org_id: string; file: any; actor_user_id: string }) =>
      examScannerAgent.ingestSheetFile(i.exam_id, i.org_id, i.file, i.actor_user_id),
    options: { timeout_ms: 120_000, max_retries: 1 },
  },

  // ---- digital exam ----
  {
    name: AGENT_NAMES.DIGITAL_EXAM_SCORE_SUBMISSION,
    agent_class: "scoring",
    handler: (i: { submission_id: string; org_id: string; actor_user_id: string }) =>
      digitalExamAgent.scoreDigitalSubmission(i.submission_id, i.org_id, i.actor_user_id),
  },
  {
    name: AGENT_NAMES.DIGITAL_EXAM_PARSE_PAPER,
    agent_class: "parser",
    handler: (i: { filename: string; buffer: Buffer; mime_type: string }) =>
      digitalExamAgent.parseUploadedExamPaper(i.filename, i.buffer, i.mime_type),
    options: { timeout_ms: 60_000 },
  },
  {
    name: AGENT_NAMES.DIGITAL_EXAM_PUBLISH,
    agent_class: "general",
    handler: (i: { exam_id: string; org_id: string; actor_user_id: string }) =>
      digitalExamAgent.publishExam(i.exam_id, i.org_id, i.actor_user_id),
  },

  // ---- verification / fraud / references ----
  {
    name: AGENT_NAMES.VERIFICATION_CHECK,
    agent_class: "verification",
    handler: (i: { candidate: any; sources: string[] }) => verificationAgent.check(i.candidate, i.sources),
    options: { timeout_ms: 60_000 },
  },
  {
    name: AGENT_NAMES.FRAUD_DETECTION_FOR_CANDIDATE,
    agent_class: "verification",
    handler: (i: { candidate_id: string; org_id: string; actor_user_id: string }) =>
      fraudDetectionAgent.runFraudDetectionForCandidate(i.candidate_id, i.org_id, i.actor_user_id),
  },
  {
    name: AGENT_NAMES.FRAUD_DETECTION_BATCH,
    agent_class: "verification",
    handler: (i: { candidate_ids: string[]; org_id: string; actor_user_id: string }) =>
      fraudDetectionAgent.runFraudDetectionBatch(i.candidate_ids, i.org_id, i.actor_user_id),
    options: { timeout_ms: 300_000 },
  },
  {
    name: AGENT_NAMES.REFERENCE_CHECK_CREATE_REQUEST,
    agent_class: "verification",
    handler: (i: { input: any; org_id: string; actor_user_id: string }) =>
      referenceCheckAgent.createAndSendReferenceRequest(i.input, i.org_id, i.actor_user_id),
  },
  {
    name: AGENT_NAMES.REFERENCE_CHECK_SUBMIT_RESPONSES,
    agent_class: "verification",
    handler: (i: { token: string; answers: any[] }) =>
      referenceCheckAgent.submitReferenceResponses(i.token, i.answers),
  },
  {
    name: AGENT_NAMES.REFERENCE_CHECK_RUN_SCORING,
    agent_class: "verification",
    handler: (i: { request_id: string; org_id: string; actor_user_id: string }) =>
      referenceCheckAgent.runReferenceScoring(i.request_id, i.org_id, i.actor_user_id),
  },

  // ---- communication ----
  {
    name: AGENT_NAMES.COMMUNICATION_SEND_BATCH,
    agent_class: "communication",
    handler: (i: { recipients: any[]; template_code: string; channel: any; org_id: string }) =>
      communicationAgent.sendBatch(i.recipients, i.template_code, i.channel, i.org_id),
    options: { timeout_ms: 60_000 },
  },
  {
    name: AGENT_NAMES.REDISCOVERY_SEND_OUTREACH,
    agent_class: "communication",
    handler: (i: { suggestion_ids: string[]; channel: any; template_code: string; org_id: string; actor_user_id: string }) =>
      rediscoveryAgent.sendOutreachBatch(i.suggestion_ids, i.channel, i.template_code, i.org_id, i.actor_user_id),
    options: { timeout_ms: 120_000 },
  },

  // ---- rediscovery / analytics (read-heavy, never write a decision) ----
  {
    name: AGENT_NAMES.REDISCOVERY_RUN_MATCH,
    agent_class: "scoring",
    handler: (i: { org_id: string; params: any; actor_user_id: string }) =>
      rediscoveryAgent.runRediscoveryMatch(i.org_id, i.params, i.actor_user_id),
    options: { timeout_ms: 300_000 },
  },
  {
    name: AGENT_NAMES.ANALYTICS_SOURCE_EFFECTIVENESS,
    agent_class: "analytics",
    handler: (i: { org_id: string; actor: string; options?: { circular_id?: string; time_window_days?: number } }) =>
      analyticsAgent.getSourceEffectivenessReport(i.org_id, i.actor, i.options ?? {}),
    options: { timeout_ms: 120_000 },
  },
  {
    name: AGENT_NAMES.ANALYTICS_FUNNEL,
    agent_class: "analytics",
    handler: (i: { org_id: string; actor: string; circular_id: string }) =>
      analyticsAgent.getFunnelAnalysisReport(i.org_id, i.actor, i.circular_id),
    options: { timeout_ms: 120_000 },
  },
  {
    name: AGENT_NAMES.ANALYTICS_QUALITY_HIRE,
    agent_class: "analytics",
    handler: (i: { org_id: string; actor: string; options?: { time_window_days?: number; source_platform?: any } }) =>
      analyticsAgent.getQualityHireReport(i.org_id, i.actor, i.options ?? {}),
    options: { timeout_ms: 120_000 },
  },
  {
    name: AGENT_NAMES.KPI_CALCULATE_AND_STORE,
    agent_class: "analytics",
    handler: (i: { kpi_id: string; employee_id: string; period: string; input_metrics: Record<string, number>; org_id: string; actor_user_id: string }) =>
      kpiAgent.calculateAndStoreScore(i.kpi_id, i.employee_id, i.period, i.input_metrics, i.org_id, i.actor_user_id),
  },
  {
    name: AGENT_NAMES.IMPROVEMENT_ADVISOR_IDENTIFY_GAPS,
    agent_class: "analytics",
    handler: (i: { org_id: string; employee_id: string; actor_user_id: string }) =>
      improvementAdvisorAgent.identifyGaps(i.org_id, i.employee_id, i.actor_user_id),
  },
  {
    name: AGENT_NAMES.REPORT_GENERATE,
    agent_class: "analytics",
    handler: (i: { type: any; circular_id: string; format: any; org_id: string; actor: string; audit_filters?: any }) =>
      reportAgent.generateReport(i.type, i.circular_id, i.format, i.org_id, i.actor, i.audit_filters),
    options: { timeout_ms: 120_000 },
  },
  {
    name: AGENT_NAMES.AUDIT_FETCH_TRAIL,
    agent_class: "analytics",
    handler: (i: { org_id: string; filters?: any }) => auditAgent.fetchAuditTrail(i.org_id, i?.filters ?? {}),
  },
  {
    name: AGENT_NAMES.AUDIT_CHECK_CONSISTENCY,
    agent_class: "analytics",
    handler: (i: { org_id: string; candidate_id?: string }) => auditAgent.checkAuditConsistency(i.org_id, i?.candidate_id),
  },

  // ---- HR ops / task logs / onboarding / offboarding ----
  {
    name: AGENT_NAMES.TASK_LOG_FLAG_OVERDUE,
    agent_class: "general",
    handler: (i: { org_id: string }) => taskLogAgent.flagOverdueTasks(i.org_id),
  },
  {
    name: AGENT_NAMES.TASK_LOG_SEND_REMINDERS,
    agent_class: "communication",
    handler: (i: { org_id: string }) => taskLogAgent.sendDueReminders(i.org_id),
  },
  {
    name: AGENT_NAMES.ONBOARDING_CREATE_ASSIGNMENTS,
    agent_class: "general",
    handler: (i: { employee_id: string; template_id: string; org_id: string; actor_user_id: string }) =>
      onboardingAgent.createAssignmentsFromTemplate(i.employee_id, i.template_id, i.org_id, i.actor_user_id),
  },
  {
    name: AGENT_NAMES.ONBOARDING_FLAG_OVERDUE,
    agent_class: "general",
    handler: () => onboardingAgent.flagOverdueAssignments(),
  },
  {
    name: AGENT_NAMES.OFFBOARDING_FLAG_OVERDUE_STEPS,
    agent_class: "general",
    handler: (i: { org_id: string }) => offboardingAgent.flagOverdueSteps(i.org_id),
  },
  {
    name: AGENT_NAMES.OFFBOARDING_SEND_STEP_REMINDERS,
    agent_class: "communication",
    handler: (i: { org_id: string }) => offboardingAgent.sendStepDueReminders(i.org_id),
  },
  {
    name: AGENT_NAMES.APPEAL_TRIAGE_RUN,
    agent_class: "general",
    handler: (i: { appeal_id: string; org_id: string }) => appealTriageAgent.triageAppeal(i.appeal_id, i.org_id),
  },
  {
    name: AGENT_NAMES.APPLICANT_PORTAL_STATUS_VIEW,
    agent_class: "general",
    handler: (i: { candidate_id: string; org_id: string; language?: string }) =>
      applicantPortalAgent.getApplicantStatusView(i.candidate_id, i.org_id, i.language),
  },

  // ---- human-in-the-loop supervisor ----
  {
    name: AGENT_NAMES.HIL_SUPERVISOR_ENQUEUE_REVIEW,
    agent_class: "general",
    handler: (i: { candidate_id: string; reason: string }) => hilSupervisorAgent.enqueueReview(i.candidate_id, i.reason),
  },
  {
    name: AGENT_NAMES.HIL_SUPERVISOR_BUILD_REVIEW_QUEUE,
    agent_class: "general",
    handler: (i: { batch_id: string }) => hilSupervisorAgent.buildReviewQueue(i.batch_id),
  },
];

let registered = false;

/**
 * Typed call surface for the agents invoked directly from route handlers.
 *
 * `invoke` (below) is `runAgent` with the input and output types pinned per
 * agent name. Both are *derived* from the agent function itself
 * (`Parameters<...>` / `ReturnType<...>`) rather than restated, so this map
 * cannot drift from the agent it describes, and a call site stays one line:
 *
 *   const report = await invoke(AGENT_NAMES.ANALYTICS_FUNNEL, { org_id, actor, circular_id });
 *
 * Only names that a caller actually uses appear here; every other agent is
 * still registered above and still reachable through `runAgent`.
 */
export type AgentContracts = {
  "analytics.source_effectiveness": {
    input: {
      org_id: string;
      actor: string;
      options?: Parameters<typeof analyticsAgent.getSourceEffectivenessReport>[2];
    };
    output: Awaited<ReturnType<typeof analyticsAgent.getSourceEffectivenessReport>>;
  };
  "analytics.funnel": {
    input: { org_id: string; actor: string; circular_id: string };
    output: Awaited<ReturnType<typeof analyticsAgent.getFunnelAnalysisReport>>;
  };
  "analytics.quality_hire": {
    input: {
      org_id: string;
      actor: string;
      options?: Parameters<typeof analyticsAgent.getQualityHireReport>[2];
    };
    output: Awaited<ReturnType<typeof analyticsAgent.getQualityHireReport>>;
  };
  "fraud_detection.batch": {
    input: { candidate_ids: string[]; org_id: string; actor_user_id: string };
    output: Awaited<ReturnType<typeof fraudDetectionAgent.runFraudDetectionBatch>>;
  };
  "rediscovery.run_match": {
    input: {
      org_id: string;
      params: Parameters<typeof rediscoveryAgent.runRediscoveryMatch>[1];
      actor_user_id: string;
    };
    output: Awaited<ReturnType<typeof rediscoveryAgent.runRediscoveryMatch>>;
  };
  "rediscovery.send_outreach": {
    input: {
      suggestion_ids: string[];
      channel: Parameters<typeof rediscoveryAgent.sendOutreachBatch>[1];
      template_code: string;
      org_id: string;
      actor_user_id: string;
    };
    output: Awaited<ReturnType<typeof rediscoveryAgent.sendOutreachBatch>>;
  };
  "dimension_scoring.run": {
    input: {
      candidate_id: string;
      org_id: string;
      persona_id: string | null;
      actor_user_id: string;
    };
    output: Awaited<ReturnType<typeof dimensionScoringAgent.runDimensionScoring>>;
  };
  "digital_exam.score_submission": {
    input: { submission_id: string; org_id: string; actor_user_id: string };
    output: Awaited<ReturnType<typeof digitalExamAgent.scoreDigitalSubmission>>;
  };
  "reference_check.run_scoring": {
    input: { request_id: string; org_id: string; actor_user_id: string };
    output: Awaited<ReturnType<typeof referenceCheckAgent.runReferenceScoring>>;
  };
  "exam_scanner.ingest_file": {
    input: {
      exam_id: string;
      org_id: string;
      file: Parameters<typeof examScannerAgent.ingestSheetFile>[2];
      actor_user_id: string;
    };
    output: Awaited<ReturnType<typeof examScannerAgent.ingestSheetFile>>;
  };
  "task_log.flag_overdue": {
    input: { org_id: string };
    output: Awaited<ReturnType<typeof taskLogAgent.flagOverdueTasks>>;
  };
  "task_log.send_reminders": {
    input: { org_id: string };
    output: Awaited<ReturnType<typeof taskLogAgent.sendDueReminders>>;
  };
  "onboarding.flag_overdue": {
    input: Record<string, never>;
    output: Awaited<ReturnType<typeof onboardingAgent.flagOverdueAssignments>>;
  };
  "offboarding.flag_overdue_steps": {
    input: { org_id: string };
    output: Awaited<ReturnType<typeof offboardingAgent.flagOverdueSteps>>;
  };
  "offboarding.send_step_reminders": {
    input: { org_id: string };
    output: Awaited<ReturnType<typeof offboardingAgent.sendStepDueReminders>>;
  };
};

/** Type-safe `runAgent` for the names listed in `AgentContracts`. */
export function invoke<N extends keyof AgentContracts>(
  name: N,
  input: AgentContracts[N]["input"],
  ctx: AgentInvocationContext = {}
): Promise<AgentContracts[N]["output"]> {
  return runAgent<AgentContracts[N]["input"], AgentContracts[N]["output"]>(name, input, ctx);
}

/**
 * Registers every agent exactly once. Called from `bootstrapAgentRuntime`
 * at process start; safe to call repeatedly (idempotent).
 *
 * Returns the number of agents registered on the first call, 0 afterwards.
 */
export function registerAllAgents(): number {
  if (registered) return 0;
  registered = true;
  registerAgents(AGENT_REGISTRATIONS);
  return AGENT_REGISTRATIONS.length;
}

/** Test hook: allow re-registration after `resetRegistry()`. */
export function resetAgentRegistrationForTests(): void {
  registered = false;
}
