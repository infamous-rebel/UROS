import { Request, Response, NextFunction } from "express";
import multer from "multer";
import { logger } from "../../utils/logger";
import { RuleEvaluationError, RuleConflictError, GateTimeoutError, FileValidationError } from "../../utils/errors";

/** Must be registered last, after all routes. */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  const requestId = req.requestId ?? req.headers["x-request-id"] ?? undefined;

  if (err instanceof RuleEvaluationError) {
    res.status(422).json({ error: "Rule evaluation error", message: err.message, requestId });
    return;
  }
  if (err instanceof RuleConflictError) {
    res.status(409).json({
      error: "Rule conflict",
      message: err.message,
      conflicting_rule_ids: err.conflictingRuleIds,
      requestId,
    });
    return;
  }
  if (err instanceof GateTimeoutError) {
    res.status(408).json({ error: "Gate timeout", message: err.message, requestId });
    return;
  }
  if (err instanceof FileValidationError) {
    res.status(400).json({ error: "Invalid file", message: err.message, requestId });
    return;
  }
  // Security Hardening Round: a rejected upload (wrong type, or over
  // the configured size limit) is an ordinary client error, not an
  // unexpected server fault — surface it as 400/413 and skip the
  // UNHANDLED_API_ERROR log noise below.
  if (err instanceof multer.MulterError) {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    res.status(status).json({ error: "File upload error", message: err.message, code: err.code, requestId });
    return;
  }

  logger.error("UNHANDLED_API_ERROR", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    path: req.path,
    method: req.method,
    requestId,
  });

  res.status(500).json({ error: "Internal server error", requestId });
}
