export type EvaluationStage = "ELIGIBILITY" | "SCORING" | "BOTH";
export type JobStatus = "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";

export interface EvaluationJobPayload {
  batch_id: string;
  circular_id: string;
  rule_pack_version_id: string;
  org_id: string;
  stage: EvaluationStage;
  requested_by: string;
}

export interface EvaluationJobRecord extends EvaluationJobPayload {
  job_id: string;
  status: JobStatus;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface EnqueueResult {
  job: EvaluationJobRecord;
  deduplicated: boolean; // true if an existing active job was returned instead of a new one
}
