/**
 * Layer 1 — Preprocessing
 *
 * Normalizes a document image for layout analysis and OCR.
 * Operations in order:
 *   1. Deskew (rotate by -detected angle)
 *   2. Denoise (median filter 3×3)
 *   3. Contrast equalization (histogram equalization)
 *   4. Otsu binarize
 *   5. Content boundary crop
 *
 * Deterministic — same input always produces same output.
 */
import {
  toGray,
  grayToPng,
  detectSkewAngle,
  rotateGray,
  gaussianBlurGray,
  equalizeHistogram,
  otsuThreshold,
  binarize,
  contentBounds,
  cropImage,
  downscale,
  type GrayImage,
} from '../shared/image-ops';
import { auditLayer, type OcrAuditEntry } from '../shared/audit';

export interface PreprocessResult {
  /** The preprocessed binary image. */
  image: GrayImage;
  /** PNG buffer of the preprocessed image (for downstream consumers). */
  imageBuffer: Buffer;
  /** Transformation metadata. */
  transforms: {
    deskew_angle: number;
    otsu_threshold: number;
    content_bbox: { x: number; y: number; w: number; h: number } | null;
    output_width: number;
    output_height: number;
  };
}

// ─── Layer entry point ───────────────────────────────────────────────────────

/**
 * Preprocess image for OCR. All operations are deterministic.
 * Returns the binary image plus transformation metadata.
 */
export async function preprocess(
  imageBufferOrGray: Buffer | GrayImage,
  correlationId: string,
): Promise<PreprocessResult> {
  // Accept GrayImage directly to skip Buffer→GrayImage decode
  const isGray = 'pixels' in imageBufferOrGray;
  let img = isGray
    ? await downscale(imageBufferOrGray as GrayImage, 1200)
    : await downscale(await toGray(imageBufferOrGray as Buffer), 1200);

  // Step 1: Deskew — detect angle on thumbnail (fast), rotate full image
  const thumb = await downscale(img, 400);
  const skewAngle = detectSkewAngle(thumb, 1); // 1° step on 400px thumbnail
  if (Math.abs(skewAngle) > 0.25) {
    img = rotateGray(img, skewAngle);
  }

  // Step 2: Denoise — pixel-domain Gaussian blur (no encode/decode)
  img = gaussianBlurGray(img);

  // Step 3: Contrast equalization — histogram equalization
  img = equalizeHistogram(img);

  // Step 4: Otsu binarize
  const threshold = otsuThreshold(img);
  img = binarize(img, threshold);

  // Step 5: Content boundary crop
  const bbox = contentBounds(img, 240);
  if (bbox && bbox.w > 50 && bbox.h > 50) {
    img = cropImage(img, bbox);
  }

  // Encode to PNG for downstream
  const outBuffer = await grayToPng(img);

  // Audit
  const entry: OcrAuditEntry = {
    correlation_id: correlationId,
    layer: 'layer-01-preprocess',
    decision: 'PREPROCESSED',
    reason_codes: [],
    evidence: {
      deskew_angle: Math.round(skewAngle * 100) / 100,
      otsu_threshold: threshold,
      output_width: img.width,
      output_height: img.height,
      has_content: bbox !== null,
    },
    timestamp: new Date().toISOString(),
  };
  auditLayer(entry);

  return {
    image: img,
    imageBuffer: outBuffer,
    transforms: {
      deskew_angle: Math.round(skewAngle * 100) / 100,
      otsu_threshold: threshold,
      content_bbox: bbox,
      output_width: img.width,
      output_height: img.height,
    },
  };
}
