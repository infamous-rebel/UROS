/**
 * OCR pipeline audit logger.
 *
 * Each layer writes structured decision records with reason_codes and evidence.
 * All records carry a correlation_id so the full pipeline trace is reconstructable.
 */
import { logger } from '../../../utils/logger';

export interface OcrAuditEntry {
  correlation_id: string;
  layer: string;
  decision: string;
  reason_codes: string[];
  evidence: Record<string, number | string | boolean>;
  timestamp: string;
}

/** Create a correlation ID for a pipeline request. */
export function createCorrelationId(): string {
  return `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Write an audit entry for a layer decision. */
export function auditLayer(entry: OcrAuditEntry): void {
  logger.info('OCR_LAYER_DECISION', {
    correlation_id: entry.correlation_id,
    layer: entry.layer,
    decision: entry.decision,
    reason_codes: entry.reason_codes,
    evidence: entry.evidence,
  });
}
