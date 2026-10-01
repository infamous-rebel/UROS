/**
 * Layer 0 — Quality Assessment
 *
 * Evaluates whether a scanned document image is usable for OCR.
 * Computes blur, contrast, resolution, skew, and noise metrics.
 * Returns usable=true/false with specific reason codes.
 *
 * Rejection thresholds:
 *   - resolution < 150 DPI → LOW_RESOLUTION
 *   - blur (content-adaptive) → BLURRY
 *   - RMS contrast < 0.08 → LOW_CONTRAST
 *   - |skew| > 15° → SEVERE_SKEW
 *
 * Blur detection uses Laplacian kurtosis to identify NID-card-type documents
 * (high kurtosis from security patterns) and applies per-population thresholds
 * on the float Laplacian variance at analysis resolution (1200px).
 */
import {
  toGray,
  imageMeta,
  laplacianVarianceFloat,
  laplacianKurtosis,
  rmsContrast,
  detectSkewAngle,
  noiseEstimate,
  type GrayImage,
} from '../shared/image-ops';
import { auditLayer, type OcrAuditEntry } from '../shared/audit';

export interface QualityMetrics {
  blur: number;
  contrast: number;
  resolution: number;
  skew: number;
  noise: number;
  kurtosis: number;
}

export interface QualityResult {
  usable: boolean;
  quality_score: number;
  issues: string[];
  metrics: QualityMetrics;
}

// ─── Thresholds ──────────────────────────────────────────────────────────────

const MIN_DPI = 150;
const MIN_CONTRAST = 0.08; // Clean docs 0.109-0.179; lowcontrast variant 0.048-0.055
const MAX_SKEW_DEGREES = 15; // NID card security patterns cause ±11° false detection

// Content-adaptive blur thresholds (float Laplacian at 1200px analysis resolution).
// NID cards have high kurtosis (>80) from security patterns; use lower threshold.
// Other document types use a higher threshold.
const NID_KURTOSIS_THRESHOLD = 80;
const NID_BLUR_THRESHOLD = 700; // NID usable: 927-1010; NID blurred: 532-535
const NON_NID_BLUR_THRESHOLD = 1760; // Lowest non-NID usable: transcript 1763; catches 14/16 non-NID blurred

// ─── Layer entry point ───────────────────────────────────────────────────────

/**
 * Assess image quality. Never throws — always returns a result.
 * The pipeline checks `usable` before proceeding to Layer 1.
 */
export async function assessQuality(
  imageBufferOrGray: Buffer | GrayImage,
  correlationId: string,
  originalDimensions?: { width: number; height: number },
): Promise<QualityResult> {
  // Accept GrayImage directly to skip Buffer→GrayImage decode
  const isGray = 'pixels' in imageBufferOrGray;
  const gray = isGray
    ? imageBufferOrGray as GrayImage
    : await toGray(imageBufferOrGray as Buffer);

  // Get metadata only if we have a Buffer (GrayImage has no metadata)
  const meta = isGray
    ? { width: gray.width, height: gray.height, dpi: 72 }
    : await imageMeta(imageBufferOrGray as Buffer);

  // Infer DPI from pixel dimensions if metadata is missing (PNG often defaults to 72)
  // Use original dimensions if provided (pipeline downscales before calling layers)
  // A4 reference: 2481px wide = 300 DPI, 1240px = 150 DPI
  const dims = originalDimensions ?? { width: meta.width, height: meta.height };
  const inferredDpi = meta.dpi <= 72 ? inferDpi(dims.width, dims.height) : meta.dpi;

  // All metrics at analysis resolution (1200px) — no further downscaling needed.
  // Skew + noise: use 4× downscaled thumbnail for speed (accuracy unaffected).
  const thumb = await downscale4x(gray);
  const metrics: QualityMetrics = {
    blur: laplacianVarianceFloat(gray),
    contrast: rmsContrast(gray),
    resolution: inferredDpi,
    skew: detectSkewAngle(thumb, 2),
    noise: noiseEstimate(thumb),
    kurtosis: laplacianKurtosis(gray),
  };

  // Evaluate rejection rules
  const issues: string[] = [];
  if (metrics.resolution < MIN_DPI) issues.push('LOW_RESOLUTION');
  if (isBlurry(metrics)) issues.push('BLURRY');
  if (metrics.contrast < MIN_CONTRAST) issues.push('LOW_CONTRAST');
  if (Math.abs(metrics.skew) > MAX_SKEW_DEGREES) issues.push('SEVERE_SKEW');

  const usable = issues.length === 0;

  // Quality score: 0-1 weighted combination of normalized metrics
  const quality_score = computeQualityScore(metrics);

  // Audit
  const entry: OcrAuditEntry = {
    correlation_id: correlationId,
    layer: 'layer-00-quality',
    decision: usable ? 'USABLE' : 'REJECTED',
    reason_codes: issues,
    evidence: {
      blur: Math.round(metrics.blur * 100) / 100,
      contrast: Math.round(metrics.contrast * 1000) / 1000,
      resolution: metrics.resolution,
      skew: Math.round(metrics.skew * 100) / 100,
      noise: Math.round(metrics.noise * 1000) / 1000,
      kurtosis: Math.round(metrics.kurtosis * 100) / 100,
      quality_score: Math.round(quality_score * 1000) / 1000,
    },
    timestamp: new Date().toISOString(),
  };
  auditLayer(entry);

  return { usable, quality_score, issues, metrics };
}

// ─── Quality score computation ───────────────────────────────────────────────

function computeQualityScore(m: QualityMetrics): number {
  // Each sub-score normalized to 0-1, then averaged
  const blurScore = Math.min(1, m.blur / 2000); // Float Laplacian: 2000+ = good
  const contrastScore = Math.min(1, m.contrast / 0.4); // 0.4+ = perfect
  const resScore = Math.min(1, m.resolution / 300); // 300+ = perfect
  const skewScore = Math.max(0, 1 - Math.abs(m.skew) / 15); // 0° = perfect
  const noiseScore = Math.max(0, 1 - m.noise / 0.5); // low noise = good

  return (blurScore + contrastScore + resScore + skewScore + noiseScore) / 5;
}

/** Content-adaptive blur check.
 *  Uses kurtosis to identify NID-card-type documents (high kurtosis from
 *  security patterns), then applies the appropriate Laplacian threshold. */
function isBlurry(m: QualityMetrics): boolean {
  if (m.kurtosis > NID_KURTOSIS_THRESHOLD) {
    return m.blur < NID_BLUR_THRESHOLD;
  }
  return m.blur < NON_NID_BLUR_THRESHOLD;
}

/** Fast 4× downscale using pixel averaging (for skew/noise metrics). */
async function downscale4x(img: GrayImage): Promise<GrayImage> {
  const { width: w, height: h } = img;
  const nw = Math.max(1, w >> 2);
  const nh = Math.max(1, h >> 2);
  const src = img.pixels;
  const out = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const sy = y << 2;
    for (let x = 0; x < nw; x++) {
      const sx = x << 2;
      let sum = 0;
      for (let dy = 0; dy < 4 && sy + dy < h; dy++) {
        const row = (sy + dy) * w;
        for (let dx = 0; dx < 4 && sx + dx < w; dx++) {
          sum += src[row + sx + dx];
        }
      }
      out[y * nw + x] = sum >> 4;
    }
  }
  return { pixels: out, width: nw, height: nh };
}

/** Infer DPI from pixel dimensions using A4 reference (210×297mm). */
function inferDpi(width: number, height: number): number {
  // A4 at 300 DPI ≈ 2481×3509; at 150 DPI ≈ 1240×1754
  // Use the larger dimension for better precision
  const longSide = Math.max(width, height);
  // A4 long side = 297mm = 11.69 inches
  const dpi = Math.round(longSide / 11.69);
  // Snap to nearest standard DPI
  if (dpi >= 250) return 300;
  if (dpi >= 125) return 150;
  return dpi;
}
