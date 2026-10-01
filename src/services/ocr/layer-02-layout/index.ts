/**
 * Layer 2 — Layout Analysis
 *
 * Detects regions in a preprocessed binary image and classifies them by role.
 * Uses connected components + projection profiles + heuristic classifications.
 *
 * Region roles: header, name_field, dob_field, roll_field, answer_column,
 *               signature, table_region, footer, unknown
 */
import {
  horizontalProjection,
  findTextLines,
  detectHorizontalLines,
  detectVerticalLines,
  type GrayImage,
  type BBox,
  type Region,
  type RegionRole,
} from '../shared/image-ops';
import { auditLayer, type OcrAuditEntry } from '../shared/audit';

export interface LayoutResult {
  regions: Region[];
}

// ─── Layer entry point ───────────────────────────────────────────────────────

/**
 * Analyze document layout. Returns detected regions with roles and confidence.
 */
export async function analyzeLayout(
  binaryImage: GrayImage,
  correlationId: string,
): Promise<LayoutResult> {
  const regions: Region[] = [];
  const img = binaryImage;

  // 1. Detect text lines via horizontal projection
  const hProfile = horizontalProjection(img, 0);
  const rawTextLines = findTextLines(hProfile, Math.max(1, Math.floor(img.width * 0.02)));

  // Filter out horizontal lines (full-width, thin bands) from text lines
  const textLines = rawTextLines.filter(line => {
    const height = line.end - line.start + 1;
    if (height > img.height * 0.05) return true; // tall enough to be text
    // Check if this band is a full-width horizontal line
    let darkPixels = 0;
    const sampleY = Math.floor((line.start + line.end) / 2);
    for (let x = 0; x < img.width; x++) {
      if (img.pixels[sampleY * img.width + x] === 0) darkPixels++;
    }
    return darkPixels < img.width * 0.7; // not a full-width line
  });

  // 2. Detect table regions (areas with both horizontal and vertical lines)
  const tableRegions = detectTables(img);
  for (const tr of tableRegions) {
    regions.push({ bbox: tr, role: 'table_region', confidence: 0.85 });
  }

  // 2b. Detect grid-pattern tables (MCQ answer grids without visible borders)
  if (tableRegions.length === 0) {
    const gridTable = detectGridPattern(img, hProfile);
    if (gridTable) {
      regions.push({ bbox: gridTable, role: 'table_region', confidence: 0.7 });
      tableRegions.push(gridTable);
    }
  }

  // 3. Classify text line bands into regions
  const lineBands = classifyTextLines(img, textLines, tableRegions);
  regions.push(...lineBands);

  // 4. Ensure at least one header region exists
  const hasHeader = regions.some(r => r.role === 'header');
  if (!hasHeader && textLines.length > 0) {
    // Mark the first text line as header
    const firstLine = textLines[0];
    const lineBbox = findLineExtent(img, firstLine.start, firstLine.end);
    if (lineBbox && lineBbox.w >= 10) {
      regions.unshift({
        bbox: { x: lineBbox.x, y: firstLine.start, w: lineBbox.w, h: firstLine.end - firstLine.start + 1 },
        role: 'header',
        confidence: 0.7,
      });
    }
  }

  // 5. Detect signature area (typically bottom-right, sparse strokes)
  const sigRegion = detectSignature(img);
  if (sigRegion) regions.push(sigRegion);

  // Audit
  const entry: OcrAuditEntry = {
    correlation_id: correlationId,
    layer: 'layer-02-layout',
    decision: 'LAYOUT_DETECTED',
    reason_codes: regions.map((r) => r.role),
    evidence: {
      total_regions: regions.length,
      text_lines: textLines.length,
      tables: tableRegions.length,
    },
    timestamp: new Date().toISOString(),
  };
  auditLayer(entry);

  return { regions };
}

// ─── Table detection ─────────────────────────────────────────────────────────

function detectTables(img: GrayImage): BBox[] {
  const hLines = detectHorizontalLines(img, 0.15);
  const vLines = detectVerticalLines(img, 0.15);

  if (hLines.length < 2) return [];

  // Find rectangular regions formed by intersecting lines
  const tables: BBox[] = [];

  // Group horizontal lines into clusters (table boundaries)
  const hGroups = groupLinesByProximity(hLines, 50);
  for (const group of hGroups) {
    if (group.length < 2) continue;
    const topY = group[0];
    const bottomY = group[group.length - 1];
    const height = bottomY - topY;
    if (height < 30) continue; // too small for a table

    // Find vertical lines within this Y range
    const relevantV = vLines.filter((x) => {
      let count = 0;
      for (let y = topY; y <= bottomY; y++) {
        if (img.pixels[y * img.width + x] === 0) count++;
      }
      return count > height * 0.3;
    });

    if (relevantV.length >= 2) {
      const leftX = Math.min(...relevantV);
      const rightX = Math.max(...relevantV);
      const width = rightX - leftX;
      if (width > 50) {
        tables.push({ x: leftX, y: topY, w: width, h: height });
      }
    } else if (group.length >= 3) {
      // Fallback: 3+ horizontal lines with consistent spacing = likely a table
      const spacing = height / (group.length - 1);
      if (spacing > 10) {
        let minX = img.width, maxX = 0;
        for (let y = topY; y <= bottomY; y++) {
          for (let x = 0; x < img.width; x++) {
            if (img.pixels[y * img.width + x] === 0) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
            }
          }
        }
        if (maxX > minX && maxX - minX > 50) {
          tables.push({ x: minX, y: topY, w: maxX - minX, h: height });
        }
      }
    }
  }

  return mergeOverlappingBoxes(tables);
}

/** Detect grid-pattern tables (MCQ answer grids) via consistent density analysis.
 *  MCQ sheets have dense, uniformly-filled answer grids where every row has
 *  similar dark pixel counts. The h-profile never drops to 0 within the grid. */
function detectGridPattern(img: GrayImage, hProf: number[]): BBox | null {
  const maxCount = img.width;

  // Find the content area (contiguous rows with dark pixels)
  let contentTop = -1, contentBottom = -1;
  for (let y = 0; y < img.height; y++) {
    if (hProf[y] > 0 && contentTop < 0) contentTop = y;
    if (hProf[y] > 0) contentBottom = y;
  }
  if (contentTop < 0 || contentBottom <= contentTop) return null;

  const contentHeight = contentBottom - contentTop + 1;
  if (contentHeight < img.height * 0.3) return null;

  // Skip the top 12% (header area) and look for grid in the remaining content
  const gridStart = contentTop + Math.floor(contentHeight * 0.12);
  const gridEnd = contentTop + Math.floor(contentHeight * 0.92);
  if (gridEnd - gridStart < img.height * 0.2) return null;

  // Check density consistency in the grid area
  const densities: number[] = [];
  for (let y = gridStart; y <= gridEnd; y++) {
    densities.push(hProf[y] / maxCount);
  }

  const avgDensity = densities.reduce((a, b) => a + b, 0) / densities.length;
  // Grid area should have moderate density (not too sparse, not too dense)
  if (avgDensity < 0.02 || avgDensity > 0.6) return null;

  const variance = densities.reduce((sum, d) => sum + (d - avgDensity) ** 2, 0) / densities.length;
  const cv = Math.sqrt(variance) / avgDensity; // coefficient of variation
  // Grid area should have LOW variation (consistent density)
  if (cv > 0.45) return null;

  // Also check that the content doesn't have large gaps (which would indicate normal text)
  const gaps = densities.filter(d => d < 0.005).length;
  if (gaps > densities.length * 0.05) return null; // too many empty rows

  // Find horizontal extent of the content
  let minX = img.width, maxX = 0;
  for (let y = gridStart; y <= gridEnd; y += 5) {
    for (let x = 0; x < img.width; x++) {
      if (img.pixels[y * img.width + x] === 0) {
        if (x < minX) minX = x;
        break;
      }
    }
    for (let x = img.width - 1; x >= 0; x--) {
      if (img.pixels[y * img.width + x] === 0) {
        if (x > maxX) maxX = x;
        break;
      }
    }
  }
  if (maxX - minX < 50) return null;

  return {
    x: minX,
    y: gridStart,
    w: maxX - minX,
    h: gridEnd - gridStart,
  };
}

function groupLinesByProximity(lines: number[], maxGap: number): number[][] {
  if (lines.length === 0) return [];
  const sorted = [...lines].sort((a, b) => a - b);
  const groups: number[][] = [[sorted[0]]];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - groups[groups.length - 1].at(-1)! <= maxGap) {
      groups[groups.length - 1].push(sorted[i]);
    } else {
      groups.push([sorted[i]]);
    }
  }
  return groups;
}

// ─── Text line classification ────────────────────────────────────────────────

function classifyTextLines(
  img: GrayImage,
  textLines: { start: number; end: number }[],
  tableRegions: BBox[],
): Region[] {
  const regions: Region[] = [];
  const imgH = img.height;

  for (let i = 0; i < textLines.length; i++) {
    const line = textLines[i];
    const lineY = (line.start + line.end) / 2;
    const lineHeight = line.end - line.start + 1;
    const relativeY = lineY / imgH; // 0 = top, 1 = bottom

    // Skip lines inside table regions
    const inTable = tableRegions.some(
      (t) => lineY >= t.y && lineY <= t.y + t.h,
    );
    if (inTable) continue;

    // Find horizontal extent of text on this line
    const lineBbox = findLineExtent(img, line.start, line.end);
    if (!lineBbox || lineBbox.w < 10) continue;

    // Classify by position
    let role: RegionRole = 'unknown';
    let confidence = 0.6;

    if (relativeY < 0.20) {
      role = 'header';
      confidence = 0.8;
    } else if (relativeY > 0.88) {
      role = 'footer';
      confidence = 0.75;
    } else {
      // Field classification by vertical position + content position
      role = classifyField(lineBbox, relativeY, lineHeight);
      confidence = 0.65;
    }

    regions.push({
      bbox: { x: lineBbox.x, y: line.start, w: lineBbox.w, h: line.end - line.start + 1 },
      role,
      confidence,
    });
  }

  return mergeAdjacentRegions(regions);
}

function findLineExtent(img: GrayImage, startY: number, endY: number): BBox | null {
  let minX = img.width, maxX = 0;
  for (let y = startY; y <= endY; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.pixels[y * img.width + x] === 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  if (maxX <= minX) return null;
  return { x: minX, y: startY, w: maxX - minX + 1, h: endY - startY + 1 };
}

function classifyField(bbox: BBox, relativeY: number, _lineHeight: number): RegionRole {
  if (bbox.x < bbox.w * 0.3 && relativeY < 0.4) {
    return 'name_field';
  }
  if (relativeY >= 0.3 && relativeY < 0.5) {
    return 'dob_field';
  }
  if (relativeY >= 0.5 && relativeY < 0.7) {
    return 'roll_field';
  }
  return 'unknown';
}

// ─── Signature detection ─────────────────────────────────────────────────────

function detectSignature(img: GrayImage): Region | null {
  const qX = Math.floor(img.width * 0.6);
  const qY = Math.floor(img.height * 0.75);
  const qW = img.width - qX;
  const qH = img.height - qY;

  let darkPixels = 0;
  let totalPixels = 0;
  for (let y = qY; y < qY + qH; y++) {
    for (let x = qX; x < qX + qW; x++) {
      totalPixels++;
      if (img.pixels[y * img.width + x] === 0) darkPixels++;
    }
  }

  const density = darkPixels / totalPixels;
  if (density > 0.02 && density < 0.2 && darkPixels > 20) {
    return {
      bbox: { x: qX, y: qY, w: qW, h: qH },
      role: 'signature',
      confidence: 0.55,
    };
  }
  return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mergeOverlappingBoxes(boxes: BBox[]): BBox[] {
  if (boxes.length <= 1) return boxes;
  const merged: BBox[] = [];

  for (const box of boxes) {
    const overlapping = merged.find(
      (m) =>
        box.x < m.x + m.w &&
        box.x + box.w > m.x &&
        box.y < m.y + m.h &&
        box.y + box.h > m.y,
    );
    if (overlapping) {
      const x1 = Math.min(overlapping.x, box.x);
      const y1 = Math.min(overlapping.y, box.y);
      const x2 = Math.max(overlapping.x + overlapping.w, box.x + box.w);
      const y2 = Math.max(overlapping.y + overlapping.h, box.y + box.h);
      overlapping.x = x1;
      overlapping.y = y1;
      overlapping.w = x2 - x1;
      overlapping.h = y2 - y1;
    } else {
      merged.push({ ...box });
    }
  }
  return merged;
}

function mergeAdjacentRegions(regions: Region[]): Region[] {
  const merged: Region[] = [];
  const gapThreshold = 15;

  for (const region of regions) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.role === region.role &&
      Math.abs(prev.bbox.x - region.bbox.x) < 30 &&
      region.bbox.y - (prev.bbox.y + prev.bbox.h) < gapThreshold
    ) {
      const newBottom = region.bbox.y + region.bbox.h;
      prev.bbox.h = newBottom - prev.bbox.y;
      prev.bbox.w = Math.max(prev.bbox.w, region.bbox.w);
      prev.confidence = Math.min(prev.confidence, region.confidence);
    } else {
      merged.push({ ...region, bbox: { ...region.bbox } });
    }
  }
  return merged;
}
