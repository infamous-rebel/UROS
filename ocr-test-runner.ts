/**
 * OCR Layers Test Runner — standalone (no jest overhead)
 * Processes all 80 samples and checks all layer thresholds.
 */
process.env.LOG_LEVEL = 'error';

import * as fs from 'fs';
import * as path from 'path';
import { assessQuality, type QualityResult } from './src/services/ocr/layer-00-quality';
import { preprocess, type PreprocessResult } from './src/services/ocr/layer-01-preprocess';
import { analyzeLayout, type LayoutResult } from './src/services/ocr/layer-02-layout';
import { extractTables, type TableExtractionResult } from './src/services/ocr/layer-02b-table';
import { runPipeline } from './src/services/ocr/pipeline';
import { createCorrelationId } from './src/services/ocr/shared/audit';
import { downscaleBuffer, rawToGray } from './src/services/ocr/shared/image-ops';

const ANALYSIS_MAX_EDGE = 1200;
const CORPUS = path.resolve(__dirname, 'tests/ocr-corpus');

interface ManifestSample {
  sample_id: string; document_type: string; script: string; quality: string;
  font_family: string; png_path: string; ground_truth_path: string;
  width: number; height: number; dpi: number;
}
interface Manifest {
  version: string; total_samples: number;
  document_types: Array<{ type: string; folder: string; count: number }>;
  quality_variants: Array<{ name: string; dpi: number }>;
  fonts: { bangla: string[]; english: string[] };
  samples: ManifestSample[];
}

function expectedQuality(q: string): { usable: boolean; reason?: string } {
  switch (q) {
    case '300dpi_clean': return { usable: true };
    case '300dpi_skewed': return { usable: true };
    case '150dpi_clean': return { usable: true };
    case '300dpi_blurred': return { usable: false, reason: 'BLURRY' };
    case '300dpi_lowcontrast': return { usable: false, reason: 'LOW_CONTRAST' };
    default: return { usable: true };
  }
}

async function main() {
  const manifest: Manifest = JSON.parse(fs.readFileSync(path.join(CORPUS, 'manifest.json'), 'utf-8'));
  const thresholds = JSON.parse(fs.readFileSync(path.join(CORPUS, 'thresholds.json'), 'utf-8'));
  const total = manifest.samples.length;

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`OCR Layers Test — ${total} samples`);
  console.log(`${'═'.repeat(70)}\n`);

  // ─── Phase 1: Compute all results ────────────────────────────────────────
  console.log('Phase 1: Computing results...');
  const startTime = Date.now();

  interface SampleResult {
    sample: ManifestSample;
    quality: QualityResult;
    preprocess: PreprocessResult | null;
    layout: LayoutResult | null;
    tables: TableExtractionResult | null;
  }
  const results: SampleResult[] = [];

  for (let i = 0; i < total; i++) {
    const sample = manifest.samples[i];
    const raw = fs.readFileSync(path.join(CORPUS, sample.png_path));
    const downscaled = await downscaleBuffer(raw, ANALYSIS_MAX_EDGE);
    const gray = rawToGray(downscaled.buffer, downscaled.width, downscaled.height);
    const cid = createCorrelationId();

    const quality = await assessQuality(gray, cid, { width: sample.width, height: sample.height });
    let pre: PreprocessResult | null = null;
    let layout: LayoutResult | null = null;
    let tables: TableExtractionResult | null = null;

    if (quality.usable) {
      pre = await preprocess(gray, cid);
      layout = await analyzeLayout(pre.image, cid);
      const tableRegions = layout.regions.filter(r => r.role === 'table_region').map(r => r.bbox);
      if (tableRegions.length > 0) {
        tables = await extractTables(pre.image, tableRegions, cid);
      }
    }

    results.push({ sample, quality, preprocess: pre, layout, tables });

    if ((i + 1) % 10 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const perSample = ((Date.now() - startTime) / (i + 1) / 1000).toFixed(2);
      console.log(`  ${i + 1}/${total} processed (${elapsed}s, ${perSample}s/sample)`);
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n  Computed in ${totalTime}s\n`);

  // ─── Phase 2: Check thresholds ───────────────────────────────────────────
  let allPassed = true;

  // Layer 0
  {
    const threshold = thresholds.defaults['layer-00-quality'].threshold;
    let correct = 0;
    const errors: string[] = [];
    for (const r of results) {
      const expected = expectedQuality(r.sample.quality);
      if (r.quality.usable === expected.usable) {
        correct++;
      } else {
        errors.push(`${r.sample.sample_id}: expected ${expected.usable ? 'USABLE' : 'REJECTED'}(${expected.reason ?? ''}), got ${r.quality.usable ? 'USABLE' : 'REJECTED'}(${r.quality.issues.join(',')}) [blur=${r.quality.metrics.blur.toFixed(0)}, contrast=${r.quality.metrics.contrast.toFixed(3)}, dpi=${r.quality.metrics.resolution}]`);
      }
    }
    const agreement = correct / total;
    const passed = agreement >= threshold;
    if (!passed) allPassed = false;
    console.log(`Layer 0 — Quality Assessment:`);
    console.log(`  Agreement: ${correct}/${total} = ${(agreement * 100).toFixed(1)}%`);
    console.log(`  Threshold: ${(threshold * 100).toFixed(1)}%`);
    console.log(`  ${passed ? '✅ PASS' : '❌ FAIL'}`);
    if (errors.length > 0) {
      console.log(`  Mismatches (${errors.length}):`);
      for (const e of errors.slice(0, 10)) console.log(`    ${e}`);
    }
    console.log();
  }

  // Layer 1
  {
    const threshold = thresholds.defaults['layer-01-preprocess'].threshold;
    const usable = results.filter(r => r.quality.usable);
    let producedRegions = 0;
    for (const r of usable) {
      if (r.layout && r.layout.regions.length > 0) producedRegions++;
    }
    const ratio = producedRegions / usable.length;
    const passed = ratio >= threshold;
    if (!passed) allPassed = false;
    console.log(`Layer 1 — Preprocessing:`);
    console.log(`  Samples producing regions: ${producedRegions}/${usable.length} = ${(ratio * 100).toFixed(1)}%`);
    console.log(`  Threshold: ${(threshold * 100).toFixed(1)}%`);
    console.log(`  ${passed ? '✅ PASS' : '❌ FAIL'}`);
    console.log();
  }

  // Layer 2
  {
    const threshold = thresholds.defaults['layer-02-layout'].threshold;
    const usable = results.filter(r => r.quality.usable);
    let withRegions = 0, withHeader = 0, withMultiple = 0, totalRegions = 0;
    for (const r of usable) {
      if (!r.layout) continue;
      totalRegions += r.layout.regions.length;
      if (r.layout.regions.length > 0) withRegions++;
      if (r.layout.regions.length >= 3) withMultiple++;
      if (r.layout.regions.some(reg => reg.role === 'header')) withHeader++;
    }
    const recall = withRegions / usable.length;
    const headerAcc = withHeader / usable.length;
    const f1 = (recall + headerAcc) / 2;
    const passed = f1 >= threshold;
    if (!passed) allPassed = false;
    console.log(`Layer 2 — Layout Analysis:`);
    console.log(`  Samples with regions: ${withRegions}/${usable.length}`);
    console.log(`  Samples with 3+ regions: ${withMultiple}/${usable.length}`);
    console.log(`  Samples with header: ${withHeader}/${usable.length}`);
    console.log(`  Total regions: ${totalRegions}`);
    console.log(`  Recall: ${(recall * 100).toFixed(1)}%, Header: ${(headerAcc * 100).toFixed(1)}%, F1: ${(f1 * 100).toFixed(1)}%`);
    console.log(`  Threshold: ${(threshold * 100).toFixed(1)}%`);
    console.log(`  ${passed ? '✅ PASS' : '❌ FAIL'}`);
    console.log();
  }

  // Layer 2b
  {
    const threshold = thresholds.defaults['layer-02b-table'].threshold;
    const tableDocTypes = ['university_transcript', 'mcq_sheet'];
    const tableSamples = results.filter(r => tableDocTypes.includes(r.sample.document_type) && r.quality.usable);
    let withTables = 0, totalCells = 0, multiRow = 0;
    for (const r of tableSamples) {
      if (r.tables && r.tables.tables.length > 0) {
        withTables++;
        for (const t of r.tables.tables) {
          totalCells += t.cells.length;
          if (t.rows >= 2) multiRow++;
        }
      } else {
        const tableRegions = r.layout?.regions.filter(reg => reg.role === 'table_region') ?? [];
        const reason = !r.tables ? 'no_layer2b_call' : 'extraction_empty';
        console.log(`    MISSING: ${r.sample.sample_id} (quality=${r.sample.quality}, table_regions=${tableRegions.length}, ${reason})`);
      }
    }
    const accuracy = withTables / tableSamples.length;
    const passed = accuracy >= threshold;
    if (!passed) allPassed = false;
    console.log(`Layer 2b — Table Extraction:`);
    console.log(`  Table-bearing samples: ${tableSamples.length}`);
    console.log(`  With extracted tables: ${withTables}/${tableSamples.length}`);
    console.log(`  Total cells: ${totalCells}, Tables with 2+ rows: ${multiRow}`);
    console.log(`  Accuracy: ${(accuracy * 100).toFixed(1)}%`);
    console.log(`  Threshold: ${(threshold * 100).toFixed(1)}%`);
    console.log(`  ${passed ? '✅ PASS' : '❌ FAIL'}`);
    console.log();
  }

  // Pipeline integration
  {
    console.log(`Pipeline Integration:`);
    const sample = manifest.samples.find(s => s.quality === '300dpi_clean')!;
    const buf = fs.readFileSync(path.join(CORPUS, sample.png_path));
    const result = await runPipeline(buf);
    console.log(`  Sample: ${sample.sample_id} (${sample.document_type}, ${sample.quality})`);
    console.log(`  Aborted: ${result.aborted}, Quality: usable=${result.quality.usable}`);
    console.log(`  Regions: ${result.layout?.regions.length ?? 0}, Tables: ${result.tables?.tables.length ?? 0}`);
    const passed = !result.aborted && result.quality.usable && result.preprocess !== null && result.layout !== null;
    if (!passed) allPassed = false;
    console.log(`  ${passed ? '✅ PASS' : '❌ FAIL'}`);
    console.log();
  }

  // Pipeline rejection
  {
    console.log(`Pipeline Rejection:`);
    const blurred = manifest.samples.find(s => s.quality === '300dpi_blurred' && s.document_type !== 'ssc_certificate')!;
    const buf = fs.readFileSync(path.join(CORPUS, blurred.png_path));
    const result = await runPipeline(buf);
    console.log(`  Sample: ${blurred.sample_id} (${blurred.quality})`);
    console.log(`  Aborted: ${result.aborted}, Reason: ${result.abort_reason}`);
    const passed = result.aborted && result.preprocess === null && result.layout === null;
    if (!passed) allPassed = false;
    console.log(`  ${passed ? '✅ PASS' : '❌ FAIL'}`);
    console.log();
  }

  // ─── Summary ─────────────────────────────────────────────────────────────
  console.log(`${'═'.repeat(70)}`);
  console.log(`Overall: ${allPassed ? '✅ ALL PASSED' : '❌ SOME FAILED'}`);
  console.log(`${'═'.repeat(70)}\n`);

  process.exit(allPassed ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
