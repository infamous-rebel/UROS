export class RuleEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleEvaluationError";
  }
}

export class RuleConflictError extends Error {
  constructor(message: string, public readonly conflictingRuleIds: string[]) {
    super(message);
    this.name = "RuleConflictError";
  }
}

export class GateTimeoutError extends Error {
  constructor(gateId: string) {
    super(`Human gate ${gateId} was not resolved within SLA`);
    this.name = "GateTimeoutError";
  }
}

/** Security Hardening Round: thrown by multer fileFilter for a rejected upload (wrong MIME type/extension). Mapped to 400 in error_handler.ts, distinct from an unexpected 500. */
export class FileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileValidationError";
  }
}
