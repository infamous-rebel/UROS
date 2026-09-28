import { createWorker } from "tesseract.js";
import { db } from "../../database/client";
import { env } from "../../config/env.schema";
import { logAudit } from "../../utils/audit_helper";
import { Candidate } from "../../models/candidate.model";
import { logger } from "../../utils/logger";

export interface ParsedCandidate extends Candidate {
  hasLowConfidenceFields: () => boolean;
  hasMissingMandatoryFields: () => boolean;
}

/**
 * Feature 5: Multi-Language Interface and Document Support.
 * Tesseract language pack(s) to run for a scanned document. "eng" is the
 * long-standing default (unchanged behavior for every existing caller
 * that doesn't specify one). "ben" runs Bangla-only OCR. "eng+ben" runs
 * Tesseract's combined bilingual model for documents that mix scripts
 * (common on Bangladeshi certificates that carry an English letterhead
 * over Bangla body text).
 */
export type OcrLanguage = "eng" | "ben" | "eng+ben";

/**
 * Raw input to the parser. `structured` documents come from APIs that
 * already return typed fields (Teletalk, bdjobs) — no OCR needed, High
 * confidence throughout. `scanned` documents are images/PDF pages that
 * require OCR (email attachments, uploaded scans).
 */
export type RawApplicationDocument =
  | {
      type: "structured";
      candidate_id: string;
      org_id: string;
      full_name: string;
      phone_primary?: string;
      email?: string;
      job_circular_id?: string;
      academic_cgpa?: number;
      academic_division?: string;
    }
  | {
      type: "scanned";
      candidate_id: string;
      org_id: string;
      job_circular_id?: string;
      image: Buffer | string; // Buffer or file path, per tesseract.js input contract
      /** Defaults to "eng" — omitting this preserves pre-Feature-5 behavior exactly. */
      ocr_language?: OcrLanguage;
    };

const MANDATORY_FIELDS = ["full_name", "phone_primary"] as const;

/** Bangla digits (০-৯) → ASCII digits, so numeric regexes (phone, CGPA) work regardless of script. */
const BANGLA_DIGIT_MAP: Record<string, string> = {
  "০": "0", "১": "1", "২": "2", "৩": "3", "৪": "4",
  "৫": "5", "৬": "6", "৭": "7", "৮": "8", "৯": "9",
};

function normalizeBanglaDigits(text: string): string {
  return text.replace(/[০-৯]/g, (d) => BANGLA_DIGIT_MAP[d] ?? d);
}

/** Bangla words for HSC/SSC division classes, as they appear on Bangladeshi certificates. */
const BANGLA_DIVISION_WORDS: Record<string, "First" | "Second" | "Third"> = {
  "প্রথম": "First",
  "দ্বিতীয়": "Second",
  "তৃতীয়": "Third",
};

/**
 * Deterministic, regex-based field extraction from raw OCR text — no
 * ML/LLM, in either script. English patterns are tried first (preserving
 * exact pre-Feature-5 output for English-only documents); Bangla label
 * patterns are only consulted for a field the English pass didn't fill,
 * so a bilingual certificate never has an English match silently
 * overwritten by a Bangla one.
 */
function extractFieldsFromOcrText(rawText: string): {
  full_name?: string;
  phone_primary?: string;
  cgpa?: number;
  division?: string;
} {
  const text = normalizeBanglaDigits(rawText);

  const phoneMatch = text.match(/\b01[3-9]\d{8}\b/);
  const cgpaMatch = text.match(/CGPA[:\s]+([0-5]\.\d{1,2})/i);
  const divisionMatch = text.match(/Division[:\s]+(First|Second|Third)/i);
  const nameMatch = text.match(/Name[:\s]+([A-Za-z .]{3,60})/i);

  // Bangla fallbacks — only consulted when the English pattern above found nothing.
  const banglaNameMatch = nameMatch ? null : text.match(/নাম[:\s]+([^\n\r০-৯]{2,60})/);
  const banglaCgpaMatch = cgpaMatch ? null : text.match(/(?:সিজিপিএ|জিপিএ)[:\s]+([0-5]\.\d{1,2})/);
  let banglaDivision: "First" | "Second" | "Third" | undefined;
  if (!divisionMatch) {
    for (const [word, value] of Object.entries(BANGLA_DIVISION_WORDS)) {
      if (text.includes(word)) {
        banglaDivision = value;
        break;
      }
    }
  }

  return {
    full_name: (nameMatch?.[1] ?? banglaNameMatch?.[1])?.trim(),
    phone_primary: phoneMatch?.[0],
    cgpa: cgpaMatch ? parseFloat(cgpaMatch[1]) : banglaCgpaMatch ? parseFloat(banglaCgpaMatch[1]) : undefined,
    division: divisionMatch?.[1] ?? banglaDivision,
  };
}

/**
 * Runs OCR over a scanned document image and returns extracted text plus
 * an overall confidence score (0–1, normalized from tesseract's 0–100).
 *
 * `language` selects the Tesseract traineddata pack(s) — "eng" (default,
 * unchanged behavior), "ben", or "eng+ben". If `env.TESSERACT_LANG_PATH`
 * is set, traineddata is loaded from that local directory instead of
 * tesseract.js's default CDN, which is required for on-premises/
 * air-gapped deployments that have no outbound network access.
 *
 * Never swallows a failure here: if worker creation or recognition
 * throws (e.g. `ben.traineddata` missing and no network to fetch it),
 * the error propagates to the caller, which routes the candidate to
 * human review rather than silently accepting unrecognized text.
 */
async function runOcr(image: Buffer | string, language: OcrLanguage = "eng"): Promise<{ text: string; confidence: number }> {
  const worker = await createWorker(language, undefined, env.TESSERACT_LANG_PATH ? { langPath: env.TESSERACT_LANG_PATH } : undefined);
  try {
    const { data } = await worker.recognize(image);
    return { text: data.text, confidence: (data.confidence ?? 0) / 100 };
  } finally {
    await worker.terminate();
  }
}

function buildParsedCandidate(
  base: {
    candidate_id: string;
    org_id: string;
    full_name?: string;
    phone_primary?: string;
    email?: string;
    job_circular_id?: string;
  },
  confidenceMap: Record<string, number>,
  academic?: { cgpa?: number; division_class?: string }
): ParsedCandidate {
  const candidate: ParsedCandidate = {
    candidate_id: base.candidate_id,
    org_id: base.org_id,
    full_name: base.full_name ?? "",
    father_name: null,
    mother_name: null,
    date_of_birth: null,
    gender: null,
    nationality: "Bangladeshi",
    national_id: null,
    phone_primary: base.phone_primary ?? null,
    email: base.email ?? null,
    present_address: null,
    permanent_address: null,
    district: null,
    division: null,
    source_platform: null,
    application_date: null,
    job_circular_id: base.job_circular_id ?? null,
    position_applied: null,
    data_confidence: null,
    duplicate_of: null,
    status: "PARSED",
    preferred_language: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    __confidence: confidenceMap,
    academic: academic
      ? [
          {
            record_id: "",
            candidate_id: base.candidate_id,
            level: "HSC",
            institution: null,
            board_or_university: null,
            passing_year: null,
            division_class: (academic.division_class as any) ?? null,
            cgpa: academic.cgpa ?? null,
            result_scale: "out of 5",
            field_confidence: confidenceMap["academic.cgpa"] ?? null,
          },
        ]
      : undefined,
    hasLowConfidenceFields(): boolean {
      return Object.values(confidenceMap).some((c) => c < env.DEFAULT_OCR_CONFIDENCE_THRESHOLD);
    },
    hasMissingMandatoryFields(): boolean {
      return MANDATORY_FIELDS.some((field) => !(base as any)[field]);
    },
  };
  return candidate;
}

/**
 * Extracts a normalized candidate record from a raw application document.
 * Structured API sources bypass OCR entirely (High confidence, no
 * black-box inference). Scanned sources run deterministic regex
 * extraction over OCR text, with per-field confidence derived from the
 * OCR engine's own confidence score.
 */
export async function extractFields(rawDocument: RawApplicationDocument): Promise<ParsedCandidate> {
  if (rawDocument.type === "structured") {
    const confidenceMap: Record<string, number> = {
      full_name: 1.0,
      phone_primary: 1.0,
      "academic.cgpa": 1.0,
    };
    const candidate = buildParsedCandidate(
      rawDocument,
      confidenceMap,
      rawDocument.academic_cgpa !== undefined
        ? { cgpa: rawDocument.academic_cgpa, division_class: rawDocument.academic_division }
        : undefined
    );

    await logAudit({
      entity_type: "CANDIDATE",
      entity_id: rawDocument.candidate_id,
      agent_or_user: "ParserAgent",
      action: "FIELDS_EXTRACTED",
      output_value: { source: "structured", confidence: "High" },
    });

    return candidate;
  }

  const ocrLanguage: OcrLanguage = rawDocument.ocr_language ?? "eng";

  try {
    const { text, confidence } = await runOcr(rawDocument.image, ocrLanguage);
    const extracted = extractFieldsFromOcrText(text);

    // Feature 5: a Bangla/bilingual pass below the configured confidence
    // threshold must never be silently accepted — every field derived
    // from it inherits the same (low) confidence score as any other OCR
    // field, so the existing hasLowConfidenceFields()/NEEDS_REVIEW
    // routing (unchanged) catches it exactly like a low-confidence
    // English scan would.
    const confidenceMap: Record<string, number> = {
      full_name: extracted.full_name ? confidence : 0,
      phone_primary: extracted.phone_primary ? confidence : 0,
      "academic.cgpa": extracted.cgpa !== undefined ? confidence : 0,
    };

    const candidate = buildParsedCandidate(
      { ...rawDocument, full_name: extracted.full_name, phone_primary: extracted.phone_primary },
      confidenceMap,
      extracted.cgpa !== undefined ? { cgpa: extracted.cgpa, division_class: extracted.division } : undefined
    );

    await logAudit({
      entity_type: "CANDIDATE",
      entity_id: rawDocument.candidate_id,
      agent_or_user: "ParserAgent",
      action: "FIELDS_EXTRACTED",
      output_value: { source: "scanned", ocr_language: ocrLanguage, ocr_confidence: confidence },
    });

    return candidate;
  } catch (err) {
    logger.error("OCR_EXTRACTION_FAILED", {
      candidate_id: rawDocument.candidate_id,
      ocr_language: ocrLanguage,
      error: err instanceof Error ? err.message : String(err),
    });

    await logAudit({
      entity_type: "CANDIDATE",
      entity_id: rawDocument.candidate_id,
      agent_or_user: "ParserAgent",
      action: "OCR_EXTRACTION_FAILED",
      reason_code: ocrLanguage === "eng" ? "OCR_ENGINE_FAILURE" : "OCR_LANGUAGE_UNAVAILABLE",
      reason_comment: err instanceof Error ? err.message : String(err),
      output_value: { ocr_language: ocrLanguage },
    });

    // Never silently drop a candidate on OCR failure — route to review
    // (hasLowConfidenceFields() returns true for confidence 0, which the
    // orchestrator/HIL Supervisor treats as NEEDS_REVIEW, never Auto-Pass).
    return buildParsedCandidate(
      { candidate_id: rawDocument.candidate_id, org_id: rawDocument.org_id, job_circular_id: rawDocument.job_circular_id },
      { full_name: 0, phone_primary: 0 }
    );
  }
}

export async function persistCandidate(candidate: ParsedCandidate): Promise<void> {
  await db.query(
    `INSERT INTO candidates
       (candidate_id, org_id, full_name, phone_primary, email, job_circular_id, data_confidence, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'PARSED')
     ON CONFLICT (candidate_id) DO UPDATE SET
       full_name=EXCLUDED.full_name,
       phone_primary=COALESCE(EXCLUDED.phone_primary, candidates.phone_primary),
       status='PARSED',
       updated_at=now()`,
    [
      candidate.candidate_id,
      candidate.org_id,
      candidate.full_name,
      candidate.phone_primary,
      candidate.email,
      candidate.job_circular_id,
      candidate.hasLowConfidenceFields() ? "Low" : "High",
    ]
  );

  if (candidate.academic?.length) {
    const record = candidate.academic[0];
    await db.query(
      `INSERT INTO candidate_academic_records
         (candidate_id, level, division_class, cgpa, result_scale, field_confidence)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [candidate.candidate_id, record.level, record.division_class, record.cgpa, record.result_scale, record.field_confidence]
    );
  }
}
