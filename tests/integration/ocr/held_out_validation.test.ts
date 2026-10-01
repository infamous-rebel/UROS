/**
 * OCR Held-Out Validation Test — Quest 06 Part 2
 *
 * Runs the full pipeline against the 20-sample VALIDATION set
 * (never used during threshold development) and asserts each layer's
 * accuracy >= its threshold.
 *
 * If a layer fails, reports the specific measurement and the gap.
 * The fix for a failing layer is a better algorithm, NOT a lower threshold.
 *
 * Run: npx jest tests/integration/ocr/held_out_validation.test.ts --verbose --forceExit
 */
process.env.LOG_LEVEL = 'error';

import * as fs from 'fs';
import * as path from 'path';
import { assessQuality, type QualityResult } from '../../../src/services/ocr/layer-00-quality';
import { preprocess, type PreprocessResult } from '../../../src/services/ocr/layer-01-preprocess';
import { analyzeLayout, type LayoutResult } from '../../../src/services/ocr/layer-02-layout';
import { extractTables, type TableExtractionResult } from '../../../src/services/ocr/layer-02b-table';
import { createCorrelationId } from '../../../src/services/ocr/shared/audit';
import { downscaleBuffer, rawToGray } from '../../../src/services/ocr/shared/image-ops';

const ANALYSIS_MAX_EDGE = 1200;
const CORPUS = path.resolve(__dirname, '../../../tests/ocr-corpus');

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
  split: string;
}

interface Manifest {
  version: string;
  total_samples: number;
  samples: ManifestSample[];
}

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

interface SampleResult {
  sample: ManifestSample;
  quality: QualityResult;
  preprocess: PreprocessResult | null;
  layout: LayoutResult | null;
  tables: TableExtractionResult | null;
}

describe('OCR Held-Out Validation', () => {
  const manifest: Manifest = JSON.parse(
    fs.readFileSync(path.join(CORPUS, 'manifest.json'), 'utf-8'),
  );
  const thresholds = JSON.parse(
    fs.readFileSync(path.join(CORPUS, 'thresholds.json'), 'utf-8'),
  );
  const validationSamples = manifest.samples.filter(s => s.split === 'validation');
  let results: SampleResult[] = [];

  beforeAll(async () => {
    console.log(`\n  Running held-out validation on ${validationSamples.length} samples...`);
    console.log(`  (These samples were NEVER used during threshold development)\n`);
    const startTime = Date.now();

    for (let i = 0; i < validationSamples.length; i++) {
      const sample = validationSamples[i];
      const raw = fs.readFileSync(path.join(CORPUS, sample.png_path));
      const downscaled = await downscaleBuffer(raw, ANALYSIS_MAX_EDGE);
      const gray = rawToGray(downscaled.buffer, downscaled.width, downscaled.height);
      const cid = createCorrelationId();

      const quality = await assessQuality(gray, cid, {
        width: sample.width,
        height: sample.height,
      });

      let pre: PreprocessResult | null = null;
      let layout: LayoutResult | null = null;
      let tables: TableExtractionResult | null = null;

      if (quality.usable) {
        pre = await preprocess(gray, cid);
        layout = await analyzeLayout(pre.image, cid);
        const tableRegions = layout.regions
          .filter((r: any) => r.role === 'table_region')
          .map((r: any) => r.bbox);
        if (tableRegions.length > 0) {
          tables = await extractTables(pre.image, tableRegions, cid);
        }
      }

      results.push({ sample, quality, preprocess: pre, layout, tables });

      if ((i + 1) % 5 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        console.log(`    ${i + 1}/${validationSamples.length} processed (${elapsed}s)`);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`  Validation results computed in ${elapsed}s\n`);
  }, 600_000);

  // ═══════════════════════════════════════════════════════════════════════════
  // LAYER 0 — Quality (held-out)
  // ═══════════════════════════════════════════════════════════════════════════

  it('Layer 0 — meets agreement threshold on held-out validation set', () => {
    const threshold = thresholds.defaults['layer-00-quality'].threshold; // 0.95
    let correct = 0;
    const errors: string[] = [];

    for (const r of results) {
      const expected = expectedQuality(r.sample.quality);
      if (r.quality.usable === expected.usable) {
        correct++;
      } else {
        errors.push(
          `${r.sample.sample_id}: expected ${expected.usable ? 'USABLE' : 'REJECTED'}(${expected.reason ?? ''}), got ${r.quality.usable ? 'USABLE' : 'REJECTED'} [blur=${r.quality.metrics.blur.toFixed(0)}, kurt=${r.quality.metrics.kurtosis.toFixed(1)}]`,
        );
      }
    }

    const total = results.length;
    const agreement = correct / total;
    const gap = threshold - agreement;

    console.log(`\n  Layer 0 — Held-Out Validation:`);
    console.log(`    Agreement: ${correct}/${total} = ${(agreement * 100).toFixed(1)}%`);
    console.log(`    Threshold: ${(threshold * 100).toFixed(1)}%`);
    if (gap > 0) {
      console.log(`    GAP: -${(gap * 100).toFixed(1)}% (need ${Math.ceil(gap * total)} more correct)`);
    }
    if (errors.length > 0) {
      console.log(`    Mismatches (${errors.length}):`);
      for (const e of errors) console.log(`      ${e}`);
    }
    console.log(`    Status: ${agreement >= threshold ? '✅ PASS' : '❌ FAIL'}`);

    expect(agreement).toBeGreaterThanOrEqual(threshold);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // LAYER 1 — Preprocessing (held-out)
  // ═══════════════════════════════════════════════════════════════════════════

  it('Layer 1 — produces preprocessed images on held-out validation set', () => {
    const threshold = thresholds.defaults['layer-01-preprocess'].threshold; // 0.90
    const usableResults = results.filter(r => r.quality.usable);
    let producedRegions = 0;

    for (const r of usableResults) {
      if (r.layout && r.layout.regions.length > 0) producedRegions++;
    }

    const ratio = usableResults.length > 0 ? producedRegions / usableResults.length : 0;
    const gap = threshold - ratio;

    console.log(`\n  Layer 1 — Held-Out Validation:`);
    console.log(`    Usable samples: ${usableResults.length}`);
    console.log(`    Producing regions: ${producedRegions}/${usableResults.length} = ${(ratio * 100).toFixed(1)}%`);
    console.log(`    Threshold: ${(threshold * 100).toFixed(1)}%`);
    if (gap > 0) console.log(`    GAP: -${(gap * 100).toFixed(1)}%`);
    console.log(`    Status: ${ratio >= threshold ? '✅ PASS' : '❌ FAIL'}`);

    expect(ratio).toBeGreaterThanOrEqual(threshold);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // LAYER 2 — Layout (held-out)
  // ═══════════════════════════════════════════════════════════════════════════

  it('Layer 2 — detects regions on held-out validation set', () => {
    const threshold = thresholds.defaults['layer-02-layout'].threshold; // 0.85
    const usableResults = results.filter(r => r.quality.usable);
    let withRegions = 0;
    let withHeader = 0;

    for (const r of usableResults) {
      if (!r.layout) continue;
      if (r.layout.regions.length > 0) withRegions++;
      if (r.layout.regions.some((reg: any) => reg.role === 'header')) withHeader++;
    }

    const recall = withRegions / usableResults.length;
    const headerAcc = withHeader / usableResults.length;
    const f1 = (recall + headerAcc) / 2;
    const gap = threshold - f1;

    console.log(`\n  Layer 2 — Held-Out Validation:`);
    console.log(`    With regions: ${withRegions}/${usableResults.length}`);
    console.log(`    With header: ${withHeader}/${usableResults.length}`);
    console.log(`    F1: ${(f1 * 100).toFixed(1)}%`);
    console.log(`    Threshold: ${(threshold * 100).toFixed(1)}%`);
    if (gap > 0) console.log(`    GAP: -${(gap * 100).toFixed(1)}%`);
    console.log(`    Status: ${f1 >= threshold ? '✅ PASS' : '❌ FAIL'}`);

    expect(f1).toBeGreaterThanOrEqual(threshold);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // LAYER 2b — Tables (held-out) — conditional
  // ═══════════════════════════════════════════════════════════════════════════

  it('Layer 2b — extracts tables on held-out validation set (if table-bearing samples exist)', () => {
    const threshold = thresholds.defaults['layer-02b-table'].threshold; // 0.80
    const tableDocTypes = ['university_transcript', 'mcq_sheet'];
    const tableSamples = results.filter(
      r => tableDocTypes.includes(r.sample.document_type) && r.quality.usable,
    );

    if (tableSamples.length === 0) {
      console.log(`\n  Layer 2b — Held-Out Validation:`);
      console.log(`    SKIPPED: no table-bearing usable samples in validation set`);
      console.log(`    (Table-bearing types: ${tableDocTypes.join(', ')})`);
      return; // pass — nothing to validate
    }

    let withTables = 0;
    for (const r of tableSamples) {
      if (r.tables && r.tables.tables.length > 0) withTables++;
    }

    const accuracy = withTables / tableSamples.length;
    const gap = threshold - accuracy;

    console.log(`\n  Layer 2b — Held-Out Validation:`);
    console.log(`    Table-bearing usable: ${tableSamples.length}`);
    console.log(`    With tables: ${withTables}/${tableSamples.length}`);
    console.log(`    Accuracy: ${(accuracy * 100).toFixed(1)}%`);
    console.log(`    Threshold: ${(threshold * 100).toFixed(1)}%`);
    if (gap > 0) console.log(`    GAP: -${(gap * 100).toFixed(1)}%`);
    console.log(`    Status: ${accuracy >= threshold ? '✅ PASS' : '❌ FAIL'}`);

    expect(accuracy).toBeGreaterThanOrEqual(threshold);
  });
});
