# Layer 0 — Quality Assessment

## Algorithm

Content-adaptive blur detection using Laplacian kurtosis to identify document populations, then per-population float Laplacian variance thresholds at 1200px analysis resolution.

| Metric | Method | Threshold |
|--------|--------|-----------|
| Resolution | Infer DPI from pixel dimensions (A4 reference) | < 150 → LOW_RESOLUTION |
| Blur (NID) | Laplacian kurtosis > 80 → NID population | float Laplacian < 700 → BLURRY |
| Blur (non-NID) | Laplacian kurtosis ≤ 80 | float Laplacian < 1760 → BLURRY |
| Contrast | RMS contrast of grayscale image | < 0.08 → LOW_CONTRAST |
| Skew | Projection profile on 4× downscaled edge image | \|angle\| > 15° → SEVERE_SKEW |

## Tuning / Validation Split

The 80-sample corpus is split into:
- **Tuning set** (60 samples): used during threshold development
- **Validation set** (20 samples): held-out, never used during development

See `tests/ocr-corpus/manifest.json` for per-sample `split` field.

## Known Exceptions

### SSC Certificate — Blurred Variant (UNVERIFIED)

**Measured accuracy gap:** 2/80 samples (SSC blurred variants) are not rejected by Layer 0.

- SSC blurred float Laplacian: 1870–1883 (above the non-NID threshold of 1760)
- SSC clean float Laplacian: 2859–3313
- Lowest usable non-SSC sample: university_transcript at 1763

**Reason:** SSC certificates have extremely high-frequency ornate border patterns that dominate the Laplacian variance even after Gaussian blur. The blur is uniform across the entire page (central ROI measurement confirms: 1853–1868 vs full-page 1870–1883). No single global threshold can reject SSC blurred (1870+) without also rejecting usable university_transcript samples (1763).

**Attempted fixes that did NOT work:**
1. Central 50% ROI Laplacian — same values as full-page (borders are not the cause)
2. Scale-space blur ratio — 150dpi clean has same ratio as blurred SSC
3. Tenengart (Sobel gradient) on central ROI — insufficient separation

**Scheduled fix:** Part 3 — document-type-aware blur thresholds using kurtosis + content classification, or a per-document-type threshold table.

**Workaround:** SSC blurred samples require human review via a different path. The pipeline should flag these for manual quality check rather than auto-rejecting.

## Measured Accuracy (Tuning Set)

| Metric | Value | Threshold |
|--------|-------|-----------|
| Agreement (tuning) | 97.5% (58/60) | ≥ 95% |
| SSC blurred escapees | 2 | documented above |
