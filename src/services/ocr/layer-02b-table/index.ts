/**
 * Layer 2b — Table Extraction
 *
 * Extracts table structure from detected table regions.
 * Uses horizontal + vertical line detection to segment cells.
 *
 * Input: regions with role = 'table_region'
 * Output: TableStructure { rows, cols, cells: Cell[] }
 */
import {
  detectHorizontalLines,
  detectVerticalLines,
  type GrayImage,
  type BBox,
} from '../shared/image-ops';
import { auditLayer, type OcrAuditEntry } from '../shared/audit';

export interface Cell {
  bbox: BBox;
  row: number;
  col: number;
  is_header: boolean;
}

export interface TableStructure {
  rows: number;
  cols: number;
  cells: Cell[];
}

export interface TableExtractionResult {
  tables: TableStructure[];
}

// ─── Layer entry point ───────────────────────────────────────────────────────

/**
 * Extract table structure from binary image, focusing on detected table regions.
 */
export async function extractTables(
  binaryImage: GrayImage,
  tableRegions: BBox[],
  correlationId: string,
): Promise<TableExtractionResult> {
  const tables: TableStructure[] = [];

  for (const region of tableRegions) {
    const structure = extractSingleTable(binaryImage, region);
    if (structure && structure.cells.length > 0) {
      tables.push(structure);
    }
  }

  // Audit
  const entry: OcrAuditEntry = {
    correlation_id: correlationId,
    layer: 'layer-02b-table',
    decision: 'TABLES_EXTRACTED',
    reason_codes: tables.map((t) => `${t.rows}x${t.cols}`),
    evidence: {
      total_tables: tables.length,
      total_cells: tables.reduce((sum, t) => sum + t.cells.length, 0),
    },
    timestamp: new Date().toISOString(),
  };
  auditLayer(entry);

  return { tables };
}

// ─── Single table extraction ─────────────────────────────────────────────────

function extractSingleTable(img: GrayImage, region: BBox): TableStructure | null {
  // Extract the table sub-image
  const subImg = extractSubImage(img, region);
  if (!subImg) return null;

  // Detect lines within the table region
  const hLines = detectHorizontalLines(subImg, 0.2);
  const vLines = detectVerticalLines(subImg, 0.2);

  if (hLines.length < 2 || vLines.length < 2) {
    // Fallback: try to detect grid from projection profiles
    return extractFromProjection(subImg, region);
  }

  // Build cell grid from line intersections
  const numRows = hLines.length - 1;
  const numCols = vLines.length - 1;
  if (numRows <= 0 || numCols <= 0) return null;

  const cells: Cell[] = [];
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const cellY = hLines[r] + region.y;
      const cellX = vLines[c] + region.x;
      const cellH = hLines[r + 1] - hLines[r];
      const cellW = vLines[c + 1] - vLines[c];

      if (cellW < 5 || cellH < 5) continue; // skip degenerate cells

      cells.push({
        bbox: { x: cellX, y: cellY, w: cellW, h: cellH },
        row: r,
        col: c,
        is_header: r === 0, // first row is header
      });
    }
  }

  return { rows: numRows, cols: numCols, cells };
}

// ─── Fallback: projection-based extraction ───────────────────────────────────

function extractFromProjection(img: GrayImage, region: BBox): TableStructure | null {
  // Use horizontal and vertical projection profiles to find row/column boundaries
  const hProfile = new Array(img.height).fill(0);
  const vProfile = new Array(img.width).fill(0);

  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.pixels[y * img.width + x] === 0) {
        hProfile[y]++;
        vProfile[x]++;
      }
    }
  }

  // Find row boundaries: rows with high dark pixel count (horizontal lines)
  const rowThreshold = img.width * 0.12;
  const rowLines: number[] = [];
  let inLine = false;
  for (let y = 0; y < img.height; y++) {
    if (hProfile[y] > rowThreshold && !inLine) {
      rowLines.push(y);
      inLine = true;
    } else if (hProfile[y] <= rowThreshold && inLine) {
      inLine = false;
    }
  }

  // Find column boundaries: columns with high dark pixel count (vertical lines)
  const colThreshold = img.height * 0.12;
  const colLines: number[] = [];
  inLine = false;
  for (let x = 0; x < img.width; x++) {
    if (vProfile[x] > colThreshold && !inLine) {
      colLines.push(x);
      inLine = true;
    } else if (vProfile[x] <= colThreshold && inLine) {
      inLine = false;
    }
  }

  // Cluster nearby lines
  const clusteredRows = clusterLines(rowLines, 10);
  const clusteredCols = clusterLines(colLines, 10);

  // If we have rows but no columns, try to infer columns from text gaps
  if (clusteredRows.length >= 2 && clusteredCols.length < 2) {
    return extractRowsOnly(img, region, clusteredRows);
  }

  if (clusteredRows.length < 2 || clusteredCols.length < 2) return null;

  const numRows = clusteredRows.length - 1;
  const numCols = clusteredCols.length - 1;
  if (numRows <= 0 || numCols <= 0) return null;

  const cells: Cell[] = [];
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const cellX = clusteredCols[c] + region.x;
      const cellY = clusteredRows[r] + region.y;
      const cellW = clusteredCols[c + 1] - clusteredCols[c];
      const cellH = clusteredRows[r + 1] - clusteredRows[r];

      if (cellW < 5 || cellH < 5) continue;

      cells.push({
        bbox: { x: cellX, y: cellY, w: cellW, h: cellH },
        row: r,
        col: c,
        is_header: r === 0,
      });
    }
  }

  return { rows: numRows, cols: numCols, cells };
}

/** Fallback: extract row structure from horizontal lines only, treat as single column. */
function extractRowsOnly(_img: GrayImage, region: BBox, rowLines: number[]): TableStructure | null {
  if (rowLines.length < 2) return null;

  const cells: Cell[] = [];
  for (let r = 0; r < rowLines.length - 1; r++) {
    const cellY = rowLines[r] + region.y;
    const cellH = rowLines[r + 1] - rowLines[r];
    if (cellH < 5) continue;

    cells.push({
      bbox: { x: region.x, y: cellY, w: region.w, h: cellH },
      row: r,
      col: 0,
      is_header: r === 0,
    });
  }

  if (cells.length === 0) return null;
  return { rows: cells.length, cols: 1, cells };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractSubImage(img: GrayImage, bbox: BBox): GrayImage | null {
  const x = Math.max(0, bbox.x);
  const y = Math.max(0, bbox.y);
  const w = Math.min(img.width - x, bbox.w);
  const h = Math.min(img.height - y, bbox.h);
  if (w <= 0 || h <= 0) return null;

  const pixels = new Uint8Array(w * h);
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      pixels[dy * w + dx] = img.pixels[(y + dy) * img.width + (x + dx)];
    }
  }
  return { pixels, width: w, height: h };
}

function clusterLines(lines: number[], maxGap: number): number[] {
  if (lines.length === 0) return [];
  const sorted = [...lines].sort((a, b) => a - b);
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
