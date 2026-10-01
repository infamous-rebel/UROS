/**
 * Shared image processing primitives for the OCR pipeline.
 *
 * All operations work on raw grayscale pixel buffers (Uint8Array).
 * No layer imports a sibling — these utilities are shared infrastructure.
 */
import sharp from 'sharp';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GrayImage {
  pixels: Uint8Array;
  width: number;
  height: number;
}

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Region {
  bbox: BBox;
  role: RegionRole;
  confidence: number;
}

export type RegionRole =
  | 'header'
  | 'name_field'
  | 'dob_field'
  | 'roll_field'
  | 'answer_column'
  | 'signature'
  | 'table_region'
  | 'footer'
  | 'unknown';

// ─── Sharp ↔ GrayImage conversion ───────────────────────────────────────────

/** Decode any image buffer to grayscale raw pixels. */
export async function toGray(buf: Buffer): Promise<GrayImage> {
  const { data, info } = await sharp(buf)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { pixels: new Uint8Array(data), width: info.width, height: info.height };
}

/** Encode a GrayImage back to PNG buffer. */
export async function grayToPng(img: GrayImage): Promise<Buffer> {
  return sharp(Buffer.from(img.pixels), {
    raw: { width: img.width, height: img.height, channels: 1 },
  })
    .png()
    .toBuffer();
}

/** Downscale a GrayImage to max dimension.
 *  Uses bilinear interpolation — no encode/decode roundtrip.
 *  Accurate enough for metric computation (Laplacian, skew, etc.). */
export async function downscale(img: GrayImage, maxDim: number): Promise<GrayImage> {
  if (img.width <= maxDim && img.height <= maxDim) return img;
  const ratio = Math.min(img.width / maxDim, img.height / maxDim);
  const newW = Math.max(1, Math.floor(img.width / ratio));
  const newH = Math.max(1, Math.floor(img.height / ratio));
  const out = new Uint8Array(newW * newH);
  const stepX = img.width / newW;
  const stepY = img.height / newH;
  const srcW = img.width, srcH = img.height, src = img.pixels;
  for (let y = 0; y < newH; y++) {
    const sy = y * stepY;
    const y0 = Math.min(Math.floor(sy), srcH - 2);
    const fy = sy - y0;
    for (let x = 0; x < newW; x++) {
      const sx = x * stepX;
      const x0 = Math.min(Math.floor(sx), srcW - 2);
      const fx = sx - x0;
      // Bilinear interpolation
      const tl = src[y0 * srcW + x0];
      const tr = src[y0 * srcW + x0 + 1];
      const bl = src[(y0 + 1) * srcW + x0];
      const br = src[(y0 + 1) * srcW + x0 + 1];
      out[y * newW + x] = Math.round(
        tl * (1 - fx) * (1 - fy) + tr * fx * (1 - fy) + bl * (1 - fx) * fy + br * fx * fy,
      );
    }
  }
  return { pixels: out, width: newW, height: newH };
}

/** Downscale a raw image buffer to max dimension, output RAW greyscale pixels.
 *  Returns the raw buffer plus its dimensions for zero-copy GrayImage construction. */
export async function downscaleBuffer(buf: Buffer, maxDim: number): Promise<{ buffer: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(buf)
    .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { buffer: Buffer.from(data), width: info.width, height: info.height };
}

/** Wrap a raw greyscale pixel buffer as GrayImage. Zero-copy — no decode.
 *  Requires known dimensions (from imageMeta or manifest). */
export function rawToGray(buf: Buffer, width: number, height: number): GrayImage {
  return { pixels: new Uint8Array(buf), width, height };
}

/** Pixel-domain Gaussian blur (separable, sigma ≈ 0.8).
 *  Avoids encode→sharp→decode roundtrip. ~100× faster for small kernels. */
export function gaussianBlurGray(img: GrayImage): GrayImage {
  // σ=0.8 → kernel [0.2262, 0.5476, 0.2262]
  const k0 = 0.2262, k1 = 0.5476;
  const { width: w, height: h } = img;
  const src = img.pixels;
  // Horizontal pass
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const l = x > 0 ? src[row + x - 1] : src[row + x];
      const c = src[row + x];
      const r = x < w - 1 ? src[row + x + 1] : src[row + x];
      tmp[row + x] = Math.round(k0 * l + k1 * c + k0 * r);
    }
  }
  // Vertical pass
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = y > 0 ? tmp[(y - 1) * w + x] : tmp[y * w + x];
      const c = tmp[y * w + x];
      const b = y < h - 1 ? tmp[(y + 1) * w + x] : tmp[y * w + x];
      out[y * w + x] = Math.round(k0 * t + k1 * c + k0 * b);
    }
  }
  return { pixels: out, width: w, height: h };
}

/** Pixel-domain Gaussian blur (separable, sigma ≈ 1.34, 5-tap).
 *  Wider kernel for scale-space analysis. */
export function gaussianBlurWideGray(img: GrayImage): GrayImage {
  // σ≈1.34 → kernel [0.0606, 0.2431, 0.3926, 0.2431, 0.0606]
  const k0 = 0.0606, k1 = 0.2431, k2 = 0.3926;
  const { width: w, height: h } = img;
  const src = img.pixels;
  // Horizontal pass
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const s2 = src[row + Math.max(0, x - 2)];
      const s1 = x > 0 ? src[row + x - 1] : src[row + x];
      const c = src[row + x];
      const r1 = x < w - 1 ? src[row + x + 1] : src[row + x];
      const r2 = src[row + Math.min(w - 1, x + 2)];
      tmp[row + x] = Math.round(k0 * s2 + k1 * s1 + k2 * c + k1 * r1 + k0 * r2);
    }
  }
  // Vertical pass
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t2 = tmp[Math.max(0, y - 2) * w + x];
      const t1 = y > 0 ? tmp[(y - 1) * w + x] : tmp[y * w + x];
      const c = tmp[y * w + x];
      const b1 = y < h - 1 ? tmp[(y + 1) * w + x] : tmp[y * w + x];
      const b2 = tmp[Math.min(h - 1, y + 2) * w + x];
      out[y * w + x] = Math.round(k0 * t2 + k1 * t1 + k2 * c + k1 * b1 + k0 * b2);
    }
  }
  return { pixels: out, width: w, height: h };
}

/** Scale-space blur metric: ratio of Laplacian variance after wide Gaussian blur
 *  to Laplacian variance at original scale. Lower = sharper, higher = more blurred.
 *  Uses float intermediates to avoid uint8 rounding artifacts. */
export function scaleSpaceBlurMetric(img: GrayImage): number {
  const lapOriginal = laplacianVarianceFloat(img);
  if (lapOriginal < 1) return 1;
  const blurred = gaussianBlurWideFloat(img);
  const lapBlurred = laplacianVarianceFloat(blurred);
  return lapBlurred / lapOriginal;
}

/** Floating-point Laplacian variance — no uint8 clamping.
 *  More accurate than uint8 version for sharp images where clamping distorts values. */
export function laplacianVarianceFloat(img: GrayImage): number {
  const { width: w, height: h } = img;
  const src = img.pixels;
  let sum = 0, sumSq = 0;
  const n = (w - 2) * (h - 2);
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const lap = src[row + x - 1] + src[row + x + 1]
                + src[(y - 1) * w + x] + src[(y + 1) * w + x]
                - 4 * src[row + x];
      sum += lap;
      sumSq += lap * lap;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** Excess kurtosis of the Laplacian response distribution.
 *  Sharp images → heavy tails (strong edge pixels) → high kurtosis.
 *  Blurred images → near-Gaussian → low kurtosis.
 *  More content-robust than variance alone. */
export function laplacianKurtosis(img: GrayImage): number {
  const { width: w, height: h } = img;
  const src = img.pixels;
  let s2 = 0, s4 = 0, count = 0;
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const lap = src[row + x - 1] + src[row + x + 1]
                + src[(y - 1) * w + x] + src[(y + 1) * w + x]
                - 4 * src[row + x];
      const l2 = lap * lap;
      s2 += l2;
      s4 += l2 * l2;
      count++;
    }
  }
  const variance = s2 / count;
  if (variance < 1e-6) return 0;
  return s4 / (count * variance * variance) - 3;
}

/** Float-intermediate Gaussian blur (σ≈1.34, 5-tap).
 *  Preserves precision by using Float64Array intermediates. */
function gaussianBlurWideFloat(img: GrayImage): GrayImage {
  const k0 = 0.0606, k1 = 0.2431, k2 = 0.3926;
  const { width: w, height: h } = img;
  const src = img.pixels;
  // Horizontal pass → Float64Array
  const tmp = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const s2 = src[row + Math.max(0, x - 2)];
      const s1 = x > 0 ? src[row + x - 1] : src[row + x];
      const c = src[row + x];
      const r1 = x < w - 1 ? src[row + x + 1] : src[row + x];
      const r2 = src[row + Math.min(w - 1, x + 2)];
      tmp[row + x] = k0 * s2 + k1 * s1 + k2 * c + k1 * r1 + k0 * r2;
    }
  }
  // Vertical pass → Float64Array, then convert to GrayImage
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t2 = tmp[Math.max(0, y - 2) * w + x];
      const t1 = y > 0 ? tmp[(y - 1) * w + x] : tmp[y * w + x];
      const c = tmp[y * w + x];
      const b1 = y < h - 1 ? tmp[(y + 1) * w + x] : tmp[y * w + x];
      const b2 = tmp[Math.min(h - 1, y + 2) * w + x];
      out[y * w + x] = Math.round(k0 * t2 + k1 * t1 + k2 * c + k1 * b1 + k0 * b2);
    }
  }
  return { pixels: out, width: w, height: h };
}

/** Pixel-domain rotation by small angle (bilinear interpolation).
 *  Avoids encode→sharp.rotate→decode roundtrip. */
export function rotateGray(img: GrayImage, angleDeg: number): GrayImage {
  const { width: srcW, height: srcH } = img;
  const rad = (angleDeg * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  // New bounding box
  const newW = Math.round(Math.abs(srcW * cosA) + Math.abs(srcH * sinA));
  const newH = Math.round(Math.abs(srcW * sinA) + Math.abs(srcH * cosA));
  const cx = srcW / 2, cy = srcH / 2;
  const ncx = newW / 2, ncy = newH / 2;
  const out = new Uint8Array(newW * newH).fill(255); // white background
  const src = img.pixels;

  for (let y = 0; y < newH; y++) {
    for (let x = 0; x < newW; x++) {
      // Inverse rotate
      const dx = x - ncx, dy = y - ncy;
      const sx = cosA * dx + sinA * dy + cx;
      const sy = -sinA * dx + cosA * dy + cy;
      // Bilinear interpolation
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const fx = sx - x0, fy = sy - y0;
      if (x0 >= 0 && x0 < srcW - 1 && y0 >= 0 && y0 < srcH - 1) {
        const tl = src[y0 * srcW + x0];
        const tr = src[y0 * srcW + x0 + 1];
        const bl = src[(y0 + 1) * srcW + x0];
        const br = src[(y0 + 1) * srcW + x0 + 1];
        out[y * newW + x] = Math.round(
          tl * (1 - fx) * (1 - fy) + tr * fx * (1 - fy) + bl * (1 - fx) * fy + br * fx * fy,
        );
      } else if (x0 >= 0 && x0 < srcW && y0 >= 0 && y0 < srcH) {
        out[y * newW + x] = src[y0 * srcW + x0];
      }
      // else: stays white (255)
    }
  }
  return { pixels: out, width: newW, height: newH };
}

/** Get image metadata (DPI, dimensions). */
export async function imageMeta(buf: Buffer): Promise<{ width: number; height: number; dpi: number }> {
  const meta = await sharp(buf).metadata();
  // sharp reports density in DPI; default 72 if unknown
  const dpi = meta.density ?? 72;
  return { width: meta.width ?? 0, height: meta.height ?? 0, dpi };
}

// ─── Pixel access helpers ────────────────────────────────────────────────────

export function getPixel(img: GrayImage, x: number, y: number): number {
  if (x < 0 || x >= img.width || y < 0 || y >= img.height) return 0;
  return img.pixels[y * img.width + x];
}

export function setPixel(img: GrayImage, x: number, y: number, v: number): void {
  if (x < 0 || x >= img.width || y < 0 || y >= img.height) return;
  img.pixels[y * img.width + x] = Math.max(0, Math.min(255, v));
}

export function cloneImage(img: GrayImage): GrayImage {
  return { pixels: new Uint8Array(img.pixels), width: img.width, height: img.height };
}

// ─── Histogram ───────────────────────────────────────────────────────────────

/** Compute 256-bin histogram. */
export function histogram(img: GrayImage): Uint32Array {
  const h = new Uint32Array(256);
  for (let i = 0; i < img.pixels.length; i++) h[img.pixels[i]]++;
  return h;
}

/** Otsu's binarization threshold. */
export function otsuThreshold(img: GrayImage): number {
  const h = histogram(img);
  const total = img.pixels.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * h[i];

  let sumB = 0, wB = 0, wF = 0;
  let maxVariance = 0, threshold = 0;

  for (let t = 0; t < 256; t++) {
    wB += h[t];
    if (wB === 0) continue;
    wF = total - wB;
    if (wF === 0) break;

    sumB += t * h[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const variance = wB * wF * (mB - mF) * (mB - mF);
    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = t;
    }
  }
  return threshold;
}

/** Binarize using a fixed threshold. */
export function binarize(img: GrayImage, threshold: number): GrayImage {
  const out = cloneImage(img);
  for (let i = 0; i < out.pixels.length; i++) {
    out.pixels[i] = out.pixels[i] < threshold ? 0 : 255;
  }
  return out;
}

// ─── Convolution ─────────────────────────────────────────────────────────────

/** Apply a 2D convolution kernel (must be odd-sized square). */
export function convolve(img: GrayImage, kernel: number[][]): GrayImage {
  const kSize = kernel.length;
  const kHalf = Math.floor(kSize / 2);
  const out = new Uint8Array(img.width * img.height);

  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      let sum = 0;
      for (let ky = 0; ky < kSize; ky++) {
        for (let kx = 0; kx < kSize; kx++) {
          const px = Math.min(img.width - 1, Math.max(0, x + kx - kHalf));
          const py = Math.min(img.height - 1, Math.max(0, y + ky - kHalf));
          sum += img.pixels[py * img.width + px] * kernel[ky][kx];
        }
      }
      out[y * img.width + x] = Math.max(0, Math.min(255, Math.round(sum)));
    }
  }
  return { pixels: out, width: img.width, height: img.height };
}

/** Laplacian variance (blur metric). Higher = sharper. */
export function laplacianVariance(img: GrayImage): number {
  const laplacian = [
    [0, 1, 0],
    [1, -4, 1],
    [0, 1, 0],
  ];
  const lap = convolve(img, laplacian);
  let sum = 0, sumSq = 0;
  const n = lap.pixels.length;
  // Treat pixel values as signed (centered at 128)
  for (let i = 0; i < n; i++) {
    const v = lap.pixels[i] - 128;
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** Tenengart criterion — mean squared gradient magnitude.
 *  Standard no-reference sharpness metric. Higher = sharper.
 *  Uses Sobel operators for noise robustness. */
export function tenengartMetric(img: GrayImage): number {
  const { width: w, height: h } = img;
  const src = img.pixels;
  let sum = 0;
  const n = (w - 2) * (h - 2);
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    const rowAbove = (y - 1) * w;
    const rowBelow = (y + 1) * w;
    for (let x = 1; x < w - 1; x++) {
      // Sobel horizontal
      const gx =
        -src[rowAbove + x - 1] + src[rowAbove + x + 1]
        - 2 * src[row + x - 1] + 2 * src[row + x + 1]
        - src[rowBelow + x - 1] + src[rowBelow + x + 1];
      // Sobel vertical
      const gy =
        -src[rowAbove + x - 1] - 2 * src[rowAbove + x] - src[rowAbove + x + 1]
        + src[rowBelow + x - 1] + 2 * src[rowBelow + x] + src[rowBelow + x + 1];
      sum += gx * gx + gy * gy;
    }
  }
  return sum / n;
}

/** Laplacian-of-Gaussian variance (blur metric at scale σ=2).
 *  Applies Gaussian blur before Laplacian to reduce sensitivity to noise
 *  and increase sensitivity to edge blur. Higher = sharper. */
export function logVariance(img: GrayImage): number {
  // Gaussian blur σ≈1.34 (5-tap kernel)
  const k0 = 0.0606, k1 = 0.2431, k2 = 0.3926;
  const { width: w, height: h } = img;
  const src = img.pixels;
  // Horizontal pass
  const tmp = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const l2 = x > 1 ? src[row + x - 2] : src[row + Math.max(0, x - 2)];
      const l1 = x > 0 ? src[row + x - 1] : src[row + x];
      const c = src[row + x];
      const r1 = x < w - 1 ? src[row + x + 1] : src[row + x];
      const r2 = x < w - 2 ? src[row + x + 2] : src[row + Math.min(w - 1, x + 2)];
      tmp[row + x] = k0 * l2 + k1 * l1 + k2 * c + k1 * r1 + k0 * r2;
    }
  }
  // Vertical pass + Laplacian in one step
  const lap = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t2 = y > 1 ? tmp[(y - 2) * w + x] : tmp[Math.max(0, y - 2) * w + x];
      const t1 = y > 0 ? tmp[(y - 1) * w + x] : tmp[y * w + x];
      const c = tmp[y * w + x];
      const b1 = y < h - 1 ? tmp[(y + 1) * w + x] : tmp[y * w + x];
      const b2 = y < h - 2 ? tmp[(y + 2) * w + x] : tmp[Math.min(h - 1, y + 2) * w + x];
      const blurred = k0 * t2 + k1 * t1 + k2 * c + k1 * b1 + k0 * b2;
      // Laplacian of the blurred image
      const lapX = x > 0 && x < w - 1 ? tmp[y * w + x - 1] + tmp[y * w + x + 1] : blurred;
      const lapY = y > 0 && y < h - 1 ? tmp[(y - 1) * w + x] + tmp[(y + 1) * w + x] : blurred;
      lap[y * w + x] = lapX + lapY - 4 * blurred;
    }
  }
  // Variance of LoG response
  let s = 0, sSq = 0;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    s += lap[i];
    sSq += lap[i] * lap[i];
  }
  const mean = s / n;
  return sSq / n - mean * mean;
}

// ─── Contrast ────────────────────────────────────────────────────────────────

/** RMS contrast (standard deviation of pixel intensities, normalized 0-1). */
export function rmsContrast(img: GrayImage): number {
  let sum = 0, sumSq = 0;
  const n = img.pixels.length;
  for (let i = 0; i < n; i++) {
    const v = img.pixels[i] / 255;
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / n;
  return Math.sqrt(sumSq / n - mean * mean);
}

// ─── Median filter ───────────────────────────────────────────────────────────

/** 2D median filter (3×3). */
export function medianFilter3x3(img: GrayImage): GrayImage {
  const out = new Uint8Array(img.width * img.height);
  const buf: number[] = new Array(9);

  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      let idx = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          buf[idx++] = getPixel(img, x + dx, y + dy);
        }
      }
      buf.sort((a, b) => a - b);
      out[y * img.width + x] = buf[4]; // median of 9
    }
  }
  return { pixels: out, width: img.width, height: img.height };
}

// ─── Histogram equalization ──────────────────────────────────────────────────

/** Contrast equalization via histogram equalization. */
export function equalizeHistogram(img: GrayImage): GrayImage {
  const h = histogram(img);
  const total = img.pixels.length;
  const lut = new Uint8Array(256);

  let cumulative = 0;
  for (let i = 0; i < 256; i++) {
    cumulative += h[i];
    lut[i] = Math.round((cumulative / total) * 255);
  }

  const out = new Uint8Array(img.pixels.length);
  for (let i = 0; i < img.pixels.length; i++) {
    out[i] = lut[img.pixels[i]];
  }
  return { pixels: out, width: img.width, height: img.height };
}

// ─── Skew detection ──────────────────────────────────────────────────────────

/** Detect dominant skew angle via projection profile at fine angle steps.
 *  Returns angle in degrees (-15 to +15). Positive = clockwise. */
export function detectSkewAngle(img: GrayImage, step = 0.5): number {
  // Use edge image for projection (edges give stronger signal)
  const sobel = convolve(img, [
    [-1, -1, -1],
    [-1, 8, -1],
    [-1, -1, -1],
  ]);

  let bestAngle = 0;
  let bestScore = -Infinity;

  for (let angle = -15; angle <= 15; angle += step) {
    const profile = horizontalProjectionAtAngle(sobel, angle);
    const score = profileVariance(profile);
    if (score > bestScore) {
      bestScore = score;
      bestAngle = angle;
    }
  }
  return bestAngle;
}

/** Compute horizontal projection profile at a given rotation angle. */
function horizontalProjectionAtAngle(img: GrayImage, angleDeg: number): number[] {
  // For small angles, we can approximate rotation by shifting rows
  const rad = (angleDeg * Math.PI) / 180;
  const profile = new Array(img.height).fill(0);

  for (let y = 0; y < img.height; y++) {
    const shift = Math.round(Math.tan(rad) * (y - img.height / 2));
    let rowSum = 0;
    for (let x = 0; x < img.width; x++) {
      const sx = x + shift;
      if (sx >= 0 && sx < img.width) {
        rowSum += img.pixels[y * img.width + sx];
      }
    }
    profile[y] = rowSum;
  }
  return profile;
}

/** Variance of a projection profile (higher = more structured). */
function profileVariance(profile: number[]): number {
  const n = profile.length;
  let sum = 0, sumSq = 0;
  for (const v of profile) {
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

// ─── Rotation ────────────────────────────────────────────────────────────────

/** Rotate image by angle degrees (uses sharp for quality). */
export async function rotateImage(img: GrayImage, angle: number): Promise<GrayImage> {
  const png = await grayToPng(img);
  const rotated = await sharp(png)
    .rotate(-angle, { background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    pixels: new Uint8Array(rotated.data),
    width: rotated.info.width,
    height: rotated.info.height,
  };
}

// ─── Content boundary crop ───────────────────────────────────────────────────

/** Find the bounding box of non-white content. */
export function contentBounds(img: GrayImage, whiteThreshold = 240): BBox | null {
  let minX = img.width, minY = img.height, maxX = 0, maxY = 0;
  let found = false;

  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.pixels[y * img.width + x] < whiteThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        found = true;
      }
    }
  }

  if (!found) return null;
  // Add small margin
  const margin = 5;
  minX = Math.max(0, minX - margin);
  minY = Math.max(0, minY - margin);
  maxX = Math.min(img.width - 1, maxX + margin);
  maxY = Math.min(img.height - 1, maxY + margin);
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Crop image to bounding box. */
export function cropImage(img: GrayImage, bbox: BBox): GrayImage {
  const out = new Uint8Array(bbox.w * bbox.h);
  for (let y = 0; y < bbox.h; y++) {
    for (let x = 0; x < bbox.w; x++) {
      const sx = bbox.x + x;
      const sy = bbox.y + y;
      if (sx < img.width && sy < img.height) {
        out[y * bbox.w + x] = img.pixels[sy * img.width + sx];
      }
    }
  }
  return { pixels: out, width: bbox.w, height: bbox.h };
}

// ─── Connected components ────────────────────────────────────────────────────

/** 4-connected component labeling. Returns label map and component bboxes. */
export function connectedComponents(
  binary: GrayImage,
  foregroundValue = 0
): { labels: Int32Array; components: BBox[] } {
  const labels = new Int32Array(binary.width * binary.height);
  const parent: number[] = [0]; // union-find, 0 = background
  let nextLabel = 1;

  // First pass: assign temporary labels
  for (let y = 0; y < binary.height; y++) {
    for (let x = 0; x < binary.width; x++) {
      const idx = y * binary.width + x;
      if (binary.pixels[idx] !== foregroundValue) continue;

      const left = x > 0 ? labels[idx - 1] : 0;
      const above = y > 0 ? labels[idx - binary.width] : 0;

      if (left === 0 && above === 0) {
        labels[idx] = nextLabel;
        parent.push(nextLabel);
        nextLabel++;
      } else if (left !== 0 && above === 0) {
        labels[idx] = left;
      } else if (left === 0 && above !== 0) {
        labels[idx] = above;
      } else {
        labels[idx] = Math.min(left, above);
        if (left !== above) union(parent, left, above);
      }
    }
  }

  // Second pass: resolve labels via union-find
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] > 0) labels[i] = find(parent, labels[i]);
  }

  // Compute bounding boxes per component
  const labelCount = Math.max(...Array.from(labels)) + 1;
  const boxes: { minX: number; minY: number; maxX: number; maxY: number }[] = [];
  for (let i = 0; i < labelCount; i++) boxes.push({ minX: Infinity, minY: Infinity, maxX: -1, maxY: -1 });

  for (let y = 0; y < binary.height; y++) {
    for (let x = 0; x < binary.width; x++) {
      const l = labels[y * binary.width + x];
      if (l === 0) continue;
      if (x < boxes[l].minX) boxes[l].minX = x;
      if (y < boxes[l].minY) boxes[l].minY = y;
      if (x > boxes[l].maxX) boxes[l].maxX = x;
      if (y > boxes[l].maxY) boxes[l].maxY = y;
    }
  }

  // Remap labels to sequential indices and build bbox array
  const labelMap = new Map<number, number>();
  const result: BBox[] = [];
  for (let i = 1; i < labelCount; i++) {
    if (boxes[i].maxX < 0) continue; // unused label
    const newIdx = result.length + 1;
    labelMap.set(i, newIdx);
    result.push({
      x: boxes[i].minX,
      y: boxes[i].minY,
      w: boxes[i].maxX - boxes[i].minX + 1,
      h: boxes[i].maxY - boxes[i].minY + 1,
    });
  }

  // Rewrite labels with sequential indices
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] > 0) labels[i] = labelMap.get(labels[i]) ?? 0;
  }

  return { labels, components: result };
}

function find(parent: number[], x: number): number {
  while (parent[x] !== x) {
    parent[x] = parent[parent[x]]; // path compression
    x = parent[x];
  }
  return x;
}

function union(parent: number[], a: number, b: number): void {
  const ra = find(parent, a);
  const rb = find(parent, b);
  if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
}

// ─── Projection profiles ─────────────────────────────────────────────────────

/** Horizontal projection profile (sum of dark pixels per row). */
export function horizontalProjection(binary: GrayImage, fg = 0): number[] {
  const profile = new Array(binary.height).fill(0);
  for (let y = 0; y < binary.height; y++) {
    let count = 0;
    for (let x = 0; x < binary.width; x++) {
      if (binary.pixels[y * binary.width + x] === fg) count++;
    }
    profile[y] = count;
  }
  return profile;
}

/** Vertical projection profile (sum of dark pixels per column). */
export function verticalProjection(binary: GrayImage, fg = 0): number[] {
  const profile = new Array(binary.width).fill(0);
  for (let x = 0; x < binary.width; x++) {
    let count = 0;
    for (let y = 0; y < binary.height; y++) {
      if (binary.pixels[y * binary.width + x] === fg) count++;
    }
    profile[x] = count;
  }
  return profile;
}

/** Find text line bands from horizontal projection (contiguous non-zero regions). */
export function findTextLines(hProfile: number[], threshold = 0): { start: number; end: number }[] {
  const lines: { start: number; end: number }[] = [];
  let inLine = false;
  let start = 0;

  for (let y = 0; y < hProfile.length; y++) {
    if (hProfile[y] > threshold && !inLine) {
      start = y;
      inLine = true;
    } else if (hProfile[y] <= threshold && inLine) {
      lines.push({ start, end: y - 1 });
      inLine = false;
    }
  }
  if (inLine) lines.push({ start, end: hProfile.length - 1 });
  return lines;
}

// ─── Line detection ──────────────────────────────────────────────────────────

/** Detect horizontal lines from vertical projection profile.
 *  Returns Y-coordinates of horizontal lines. */
export function detectHorizontalLines(binary: GrayImage, minDensity = 0.3): number[] {
  const lines: number[] = [];

  // A horizontal line creates a row where most pixels are dark
  for (let y = 0; y < binary.height; y++) {
    let darkCount = 0;
    for (let x = 0; x < binary.width; x++) {
      if (binary.pixels[y * binary.width + x] === 0) darkCount++;
    }
    if (darkCount > binary.width * minDensity) {
      lines.push(y);
    }
  }

  // Cluster nearby lines (within 3px)
  return clusterValues(lines, 3);
}

/** Detect vertical lines from horizontal projection profile.
 *  Returns X-coordinates of vertical lines. */
export function detectVerticalLines(binary: GrayImage, minDensity = 0.3): number[] {
  const lines: number[] = [];

  for (let x = 0; x < binary.width; x++) {
    let darkCount = 0;
    for (let y = 0; y < binary.height; y++) {
      if (binary.pixels[y * binary.width + x] === 0) darkCount++;
    }
    if (darkCount > binary.height * minDensity) {
      lines.push(x);
    }
  }

  return clusterValues(lines, 3);
}

/** Cluster nearby values, returning cluster centers. */
function clusterValues(values: number[], maxGap: number): number[] {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const clusters: number[][] = [[sorted[0]]];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - clusters[clusters.length - 1].at(-1)! <= maxGap) {
      clusters[clusters.length - 1].push(sorted[i]);
    } else {
      clusters.push([sorted[i]]);
    }
  }

  return clusters.map((c) => Math.round(c.reduce((a, b) => a + b, 0) / c.length));
}

// ─── Noise estimation ────────────────────────────────────────────────────────

/** High-frequency energy estimate (sum of squared high-pass filter response). */
export function noiseEstimate(img: GrayImage): number {
  // 3x3 high-pass kernel
  const hp = [
    [0, -1, 0],
    [-1, 4, -1],
    [0, -1, 0],
  ];
  const filtered = convolve(img, hp);
  let energy = 0;
  for (let i = 0; i < filtered.pixels.length; i++) {
    const v = (filtered.pixels[i] - 128) / 128;
    energy += v * v;
  }
  return energy / filtered.pixels.length;
}
