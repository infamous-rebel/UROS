/**
 * OCR Pipeline Orchestrator
 *
 * Runs layers 0 → 1 → 2 → 2b in order.
 * Stops early if Layer 0 rejects the image.
 * Structured logging per layer with per-request correlation IDs.
 *
 * No layer imports a sibling — this module is the sole coordinator.
 */
import { assessQuality, type QualityResult } from './layer-00-quality';
import { preprocess, type PreprocessResult } from './layer-01-preprocess';
import { analyzeLayout, type LayoutResult } from './layer-02-layout';
import { extractTables, type TableExtractionResult } from './layer-02b-table';
import { createCorrelationId, auditLayer } from './shared/audit';
import { downscaleBuffer, imageMeta, rawToGray } from './shared/image-ops';
import { logger } from '../../utils/logger';

// ─── Constants ───────────────────────────────────────────────────────────────

/** All layers operate at this resolution. Full-res is never needed for OCR decisions. */
const ANALYSIS_MAX_EDGE = 1200;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PipelineResult {
  correlation_id: string;
  quality: QualityResult;
  preprocess: PreprocessResult | null;
  layout: LayoutResult | null;
  tables: TableExtractionResult | null;
  aborted: boolean;
  abort_reason?: string;
}

// ─── Pipeline entry point ────────────────────────────────────────────────────

/**
 * Run the full OCR pipeline on an image buffer.
 * Returns results from all layers, or aborts if Layer 0 rejects.
 */
export async function runPipeline(imageBuffer: Buffer): Promise<PipelineResult> {
  const correlationId = createCorrelationId();
  const startTime = Date.now();

  logger.info('OCR_PIPELINE_START', { correlation_id: correlationId });

  // ── Downscale once at entry — all layers work at ANALYSIS_MAX_EDGE ──────
  const [analysisRaw, originalMeta] = await Promise.all([
    downscaleBuffer(imageBuffer, ANALYSIS_MAX_EDGE),
    imageMeta(imageBuffer), // fast: reads PNG header only
  ]);

  // Wrap raw pixels as GrayImage — zero-copy, no PNG decode
  const analysisGray = rawToGray(analysisRaw.buffer, analysisRaw.width, analysisRaw.height);

  // ── Layer 0: Quality Assessment ──────────────────────────────────────────
  const quality = await assessQuality(analysisGray, correlationId, {
    width: originalMeta.width,
    height: originalMeta.height,
  });

  if (!quality.usable) {
    logger.warn('OCR_PIPELINE_ABORTED', {
      correlation_id: correlationId,
      reason: 'quality_rejected',
      issues: quality.issues,
      elapsed_ms: Date.now() - startTime,
    });

    auditLayer({
      correlation_id: correlationId,
      layer: 'pipeline',
      decision: 'ABORTED',
      reason_codes: quality.issues,
      evidence: { quality_score: quality.quality_score },
      timestamp: new Date().toISOString(),
    });

    return {
      correlation_id: correlationId,
      quality,
      preprocess: null,
      layout: null,
      tables: null,
      aborted: true,
      abort_reason: `Quality rejected: ${quality.issues.join(', ')}`,
    };
  }

  // ── Layer 1: Preprocessing ───────────────────────────────────────────────
  const preprocessResult = await preprocess(analysisGray, correlationId);

  // ── Layer 2: Layout Analysis ─────────────────────────────────────────────
  const layoutResult = await analyzeLayout(preprocessResult.image, correlationId);

  // ── Layer 2b: Table Extraction ───────────────────────────────────────────
  const tableRegions = layoutResult.regions
    .filter((r) => r.role === 'table_region')
    .map((r) => r.bbox);

  const tableResult =
    tableRegions.length > 0
      ? await extractTables(preprocessResult.image, tableRegions, correlationId)
      : { tables: [] };

  // ── Done ─────────────────────────────────────────────────────────────────
  const elapsed = Date.now() - startTime;
  logger.info('OCR_PIPELINE_COMPLETE', {
    correlation_id: correlationId,
    elapsed_ms: elapsed,
    regions: layoutResult.regions.length,
    tables: tableResult.tables.length,
  });

  return {
    correlation_id: correlationId,
    quality,
    preprocess: preprocessResult,
    layout: layoutResult,
    tables: tableResult,
    aborted: false,
  };
}
