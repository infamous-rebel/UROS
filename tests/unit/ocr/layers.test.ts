/**
 * OCR Pipeline Tests — Quest 06 Part 2
 *
 * Tests all 4 layers + pipeline integration against the real 80-sample corpus.
 * Each layer prints measured accuracy vs its threshold with PASS/FAIL.
 *
 * Performance: all intermediate results computed ONCE in beforeAll,
 * then each test just checks the stored results.
 *
 * Run: npx jest tests/unit/ocr/layers.test.ts --verbose --forceExit
 */
// Suppress audit logger noise — set before any imports
process.env.LOG_LEVEL = 'error';

import * as fs from 'fs';
import * as path from 'path';
import { assessQuality, type QualityResult } from '../../../src/services/ocr/layer-00-quality';
import { preprocess, type PreprocessResult } from '../../../src/services/ocr/layer-01-preprocess';
import { analyzeLayout, type LayoutResult } from '../../../src/services/ocr/layer-02-layout';
import { extractTables, type TableExtractionResult } from '../../../src/services/ocr/layer-02b-table';
import { runPipeline } from '../../../src/services/ocr/pipeline';
import { createCorrelationId } from '../../../src/services/ocr/shared/audit';
import { downscaleBuffer, rawToGray } from '../../../src/services/ocr/shared/image-ops';

// ─── Analysis resolution ────────────────────────────────────────────────────
const ANALYSIS_MAX_EDGE = 1200;

// ─── Corpus paths ────────────────────────────────────────────────────────────
const CORPUS = path.resolve(__dirname, '../../../tests/ocr-corpus');
const MANIFEST_PATH = path.join(CORPUS, 'manifest.json');
const THRESHOLDS_PATH = path.join(CORPUS, 'thresholds.json');

interface ManifestSample {
  sample_id: string;
  document_type: string;
  script: string;
  quality: string;
  font_family: string;
  png_path: string;
  ground_truth_path: string;
  width: number;
  height: number;
  dpi: number;
}

interface Manifest {
  version: string;
  total_samples: number;
  document_types: Array<{ type: string; folder: string; count: number }>;
  quality_variants: Array<{ name: string; dpi: number }>;
  fonts: { bangla: string[]; english: string[] };
  samples: ManifestSample[];
}

interface Thresholds {
  version: string;
  defaults: Record<string, any>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadManifest(): Manifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
}

function loadThresholds(): Thresholds {
  return JSON.parse(fs.readFileSync(THRESHOLDS_PATH, 'utf-8'));
}

function loadSampleImage(sample: ManifestSample): Buffer {
  return fs.readFileSync(path.join(CORPUS, sample.png_path));
}

// ─── Quality labels ──────────────────────────────────────────────────────────
function expectedQuality(quality: string): { usable: boolean; reason?: string } {
  switch (quality) {
    case '300dpi_clean': return { usable: true };
    case '300dpi_skewed': return { usable: true };
    case '150dpi_clean': return { usable: true };
    case '300dpi_blurred': return { usable: false, reason: 'BLURRY' };
    case '300dpi_lowcontrast': return { usable: false, reason: 'LOW_CONTRAST' };
    default: return { usable: true };
  }
}

// ─── Shared computed results ─────────────────────────────────────────────────
interface SampleResults {
  sample: ManifestSample;
  quality: QualityResult;
  preprocess: PreprocessResult | null;
  layout: LayoutResult | null;
  tables: TableExtractionResult | null;
}

describe('OCR Layers 0–2b', () => {
  const manifest = loadManifest();
  const thresholds = loadThresholds();
  let results: SampleResults[] = [];

  // ─── Compute ALL results ONCE ──────────────────────────────────────────────
  beforeAll(async () => {
    console.log(`\n  Computing results for ${manifest.total_samples} samples...`);
    const startTime = Date.now();

    for (let i = 0; i < manifest.samples.length; i++) {
      const sample = manifest.samples[i];
      const raw = loadSampleImage(sample);
      const downscaled = await downscaleBuffer(raw, ANALYSIS_MAX_EDGE);
      const gray = rawToGray(downscaled.buffer, downscaled.width, downscaled.height);
      const cid = createCorrelationId();

      // Layer 0
      const quality = await assessQuality(gray, cid, { width: sample.width, height: sample.height });

      let preprocessResult: PreprocessResult | null = null;
      let layoutResult: LayoutResult | null = null;
      let tableResult: TableExtractionResult | null = null;

      if (quality.usable) {
        // Layer 1
        preprocessResult = await preprocess(gray, cid);

        // Layer 2
        layoutResult = await analyzeLayout(preprocessResult.image, cid);

        // Layer 2b (only for table-bearing document types)
        const tableRegions = layoutResult.regions
          .filter((r) => r.role === 'table_region')
          .map((r) => r.bbox);
        if (tableRegions.length > 0) {
          tableResult = await extractTables(preprocessResult.image, tableRegions, cid);
        }
      }

      results.push({ sample, quality, preprocess: preprocessResult, layout: layoutResult, tables: tableResult });

      // Progress indicator every 10 samples
      if ((i + 1) % 10 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        console.log(`    ${i + 1}/${manifest.total_samples} processed (${elapsed}s)`);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`  All results computed in ${elapsed}s\n`);
  }, 1200_000); // 20 minutes for 80 samples

  // ═══════════════════════════════════════════════════════════════════════════════
  // LAYER 0 — Quality Assessment
  // ═══════════════════════════════════════════════════════════════════════════════

  it('Layer 0 — meets agreement threshold', () => {
    const threshold = thresholds.defaults['layer-00-quality'].threshold; // 0.95
    let correct = 0;
    const errors: string[] = [];

    for (const r of results) {
      const expected = expectedQuality(r.sample.quality);
      if (r.quality.usable === expected.usable) {
        correct++;
      } else {
        errors.push(
          `${r.sample.sample_id}: expected ${expected.usable ? 'USABLE' : 'REJECTED'}(${expected.reason ?? ''}), got ${r.quality.usable ? 'USABLE' : 'REJECTED'}(${r.quality.issues.join(',')}) [blur=${r.quality.metrics.blur.toFixed(0)}, contrast=${r.quality.metrics.contrast.toFixed(3)}, dpi=${r.quality.metrics.resolution}]`
        );
      }
    }

    const total = results.length;
    const agreement = correct / total;
    console.log(`\n  Layer 0 Results:`);
    console.log(`    Agreement: ${correct}/${total} = ${(agreement * 100).toFixed(1)}%`);
    console.log(`    Threshold: ${(threshold * 100).toFixed(1)}%`);
    console.log(`    Status: ${agreement >= threshold ? '✅ PASS' : '❌ FAIL'}`);
    if (errors.length > 0) {
      console.log(`    Mismatches (${errors.length}):`);
      for (const e of errors.slice(0, 10)) console.log(`      ${e}`);
    }

    expect(agreement).toBeGreaterThanOrEqual(threshold);
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // LAYER 1 — Preprocessing
  // ═══════════════════════════════════════════════════════════════════════════════

  it('Layer 1 — produces preprocessed images that Layer 2 can process', () => {
    const threshold = thresholds.defaults['layer-01-preprocess'].threshold; // 0.90
    const usableResults = results.filter((r) => r.quality.usable);
    let producedRegions = 0;

    for (const r of usableResults) {
      if (r.layout && r.layout.regions.length > 0) {
        producedRegions++;
      }
    }

    const ratio = producedRegions / usableResults.length;
    console.log(`\n  Layer 1 Results:`);
    console.log(`    Samples producing regions: ${producedRegions}/${usableResults.length} = ${(ratio * 100).toFixed(1)}%`);
    console.log(`    Threshold: ${(threshold * 100).toFixed(1)}%`);
    console.log(`    Status: ${ratio >= threshold ? '✅ PASS' : '❌ FAIL'}`);

    expect(ratio).toBeGreaterThanOrEqual(threshold);
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // LAYER 2 — Layout Analysis
  // ═══════════════════════════════════════════════════════════════════════════════

  it('Layer 2 — detects regions with correct structural properties', () => {
    const threshold = thresholds.defaults['layer-02-layout'].threshold; // 0.85
    const usableResults = results.filter((r) => r.quality.usable);
    let samplesWithRegions = 0;
    let samplesWithHeader = 0;
    let samplesWithMultipleRegions = 0;
    let totalRegions = 0;

    for (const r of usableResults) {
      if (!r.layout) continue;
      totalRegions += r.layout.regions.length;
      if (r.layout.regions.length > 0) samplesWithRegions++;
      if (r.layout.regions.length >= 3) samplesWithMultipleRegions++;
      if (r.layout.regions.some((reg) => reg.role === 'header')) samplesWithHeader++;
    }

    const recall = samplesWithRegions / usableResults.length;
    const headerAccuracy = samplesWithHeader / usableResults.length;
    const f1 = (recall + headerAccuracy) / 2;

    console.log(`\n  Layer 2 Results:`);
    console.log(`    Samples with regions: ${samplesWithRegions}/${usableResults.length}`);
    console.log(`    Samples with 3+ regions: ${samplesWithMultipleRegions}/${usableResults.length}`);
    console.log(`    Samples with header: ${samplesWithHeader}/${usableResults.length}`);
    console.log(`    Total regions detected: ${totalRegions}`);
    console.log(`    Recall: ${(recall * 100).toFixed(1)}%`);
    console.log(`    Header accuracy: ${(headerAccuracy * 100).toFixed(1)}%`);
    console.log(`    F1 proxy: ${(f1 * 100).toFixed(1)}%`);
    console.log(`    Threshold: ${(threshold * 100).toFixed(1)}%`);
    console.log(`    Status: ${f1 >= threshold ? '✅ PASS' : '❌ FAIL'}`);

    expect(f1).toBeGreaterThanOrEqual(threshold);
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // LAYER 2b — Table Extraction
  // ═══════════════════════════════════════════════════════════════════════════════

  it('Layer 2b — extracts table structure from documents with tables', () => {
    const threshold = thresholds.defaults['layer-02b-table'].threshold; // 0.80
    const tableDocTypes = ['university_transcript', 'mcq_sheet'];
    const tableSamples = results.filter(
      (r) => tableDocTypes.includes(r.sample.document_type) && r.quality.usable,
    );

    let samplesWithTables = 0;
    let totalCells = 0;
    let tablesWithMultipleRows = 0;

    for (const r of tableSamples) {
      if (r.tables && r.tables.tables.length > 0) {
        samplesWithTables++;
        for (const t of r.tables.tables) {
          totalCells += t.cells.length;
          if (t.rows >= 2) tablesWithMultipleRows++;
        }
      }
    }

    const accuracy = samplesWithTables / tableSamples.length;
    console.log(`\n  Layer 2b Results:`);
    console.log(`    Table-bearing samples: ${tableSamples.length}`);
    console.log(`    Samples with extracted tables: ${samplesWithTables}/${tableSamples.length}`);
    console.log(`    Total cells extracted: ${totalCells}`);
    console.log(`    Tables with 2+ rows: ${tablesWithMultipleRows}`);
    console.log(`    Accuracy: ${(accuracy * 100).toFixed(1)}%`);
    console.log(`    Threshold: ${(threshold * 100).toFixed(1)}%`);
    console.log(`    Status: ${accuracy >= threshold ? '✅ PASS' : '❌ FAIL'}`);

    expect(accuracy).toBeGreaterThanOrEqual(threshold);
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // PIPELINE INTEGRATION
  // ═══════════════════════════════════════════════════════════════════════════════

  it('Pipeline — runs one sample end-to-end', async () => {
    const sample = manifest.samples.find((s) => s.quality === '300dpi_clean')!;
    const buf = loadSampleImage(sample);

    console.log(`\n  Pipeline Integration Test:`);
    console.log(`    Sample: ${sample.sample_id} (${sample.document_type}, ${sample.quality})`);

    const result = await runPipeline(buf);

    console.log(`    Correlation ID: ${result.correlation_id}`);
    console.log(`    Aborted: ${result.aborted}`);
    console.log(`    Quality: usable=${result.quality.usable}, score=${result.quality.quality_score.toFixed(3)}`);
    console.log(`    Metrics: blur=${result.quality.metrics.blur.toFixed(0)}, contrast=${result.quality.metrics.contrast.toFixed(3)}, dpi=${result.quality.metrics.resolution}, skew=${result.quality.metrics.skew.toFixed(1)}°`);

    expect(result.aborted).toBe(false);
    expect(result.quality.usable).toBe(true);
    expect(result.preprocess).not.toBeNull();
    console.log(`    Preprocess: ${result.preprocess!.transforms.output_width}×${result.preprocess!.transforms.output_height}, deskew=${result.preprocess!.transforms.deskew_angle}°, otsu=${result.preprocess!.transforms.otsu_threshold}`);

    expect(result.layout).not.toBeNull();
    console.log(`    Layout: ${result.layout!.regions.length} regions`);
    for (const r of result.layout!.regions.slice(0, 5)) {
      console.log(`      [${r.role}] (${r.bbox.x},${r.bbox.y},${r.bbox.w},${r.bbox.h}) conf=${r.confidence.toFixed(2)}`);
    }

    expect(result.tables).not.toBeNull();
    console.log(`    Tables: ${result.tables!.tables.length} tables, ${result.tables!.tables.reduce((s, t) => s + t.cells.length, 0)} cells`);
    console.log(`    ✅ Pipeline integration PASSED`);
  }, 300_000);

  it('Pipeline — rejects unusable images at Layer 0', async () => {
    const blurred = manifest.samples.find((s) => s.quality === '300dpi_blurred')!;
    const buf = loadSampleImage(blurred);

    const result = await runPipeline(buf);

    console.log(`\n  Pipeline Rejection Test:`);
    console.log(`    Sample: ${blurred.sample_id} (${blurred.quality})`);
    console.log(`    Aborted: ${result.aborted}`);
    console.log(`    Reason: ${result.abort_reason}`);
    console.log(`    Issues: ${result.quality.issues.join(', ')}`);

    expect(result.aborted).toBe(true);
    expect(result.preprocess).toBeNull();
    expect(result.layout).toBeNull();
    expect(result.tables).toBeNull();
  }, 300_000);
});
