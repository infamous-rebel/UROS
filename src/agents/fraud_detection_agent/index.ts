import { PoolClient } from "pg";
import { db } from "../../database/client";
import { applyOperator } from "../../rules/engine/operators";
import { logAudit } from "../../utils/audit_helper";
import {
  FraudCheckType,
  FRAUD_CHECK_TYPES,
  FraudCheck,
  FraudCandidateProfile,
  FraudAcademicEntry,
  FraudExperienceEntry,
  OtherCandidateIdentity,
  FraudCheckOutcome,
  FraudSeverity,
  AgeEducationTimelineConfig,
  CgpaDivisionConsistencyConfig,
  ExperienceOverlapConfig,
  DuplicateIdentityConfig,
  ImpossibleDobGraduationConfig,
  FraudDetectionCandidateResult,
} from "../../models/fraud.model";

/**
 * System defaults used for any check_type an org has not explicitly
 * configured via POST /fraud/configure. All numeric values here are
 * illustrative starting points (matching this project's own data
 * caveats — see 12_Data_References_and_Sources.md §2: figures are
 * indicative, not exact) and are fully overridable per org. Nothing in
 * this feature depends on these specific numbers being "correct" —
 * they only need to be deterministic and visible.
 */
export const DEFAULT_CHECK_CONFIGS: {
  AGE_EDUCATION_TIMELINE: AgeEducationTimelineConfig;
  CGPA_DIVISION_CONSISTENCY: CgpaDivisionConsistencyConfig;
  EXPERIENCE_OVERLAP: ExperienceOverlapConfig;
  DUPLICATE_IDENTITY: DuplicateIdentityConfig;
  IMPOSSIBLE_DOB_GRADUATION_AGE: ImpossibleDobGraduationConfig;
} = {
  AGE_EDUCATION_TIMELINE: {
    min_age_by_level: { SSC: 14, Diploma: 15, HSC: 16, Bachelor: 19, Masters: 21, Other: 14 },
    min_level_gap_years: 1,
  },
  CGPA_DIVISION_CONSISTENCY: {
    scale_4: { first_division_min_cgpa: 3.0, second_division_min_cgpa: 2.0 },
    scale_5: { first_division_min_cgpa: 3.5, second_division_min_cgpa: 2.5 },
    tolerance: 0,
  },
  EXPERIENCE_OVERLAP: { max_allowed_overlap_days: 30 },
  DUPLICATE_IDENTITY: { fields: ["national_id", "phone_primary", "email"] },
  IMPOSSIBLE_DOB_GRADUATION_AGE: { max_plausible_age_years: 80 },
};

const DEFAULT_SEVERITY: Record<FraudCheckType, { fail: FraudSeverity; review: FraudSeverity }> = {
  AGE_EDUCATION_TIMELINE: { fail: "MEDIUM", review: "LOW" },
  CGPA_DIVISION_CONSISTENCY: { fail: "MEDIUM", review: "LOW" },
  EXPERIENCE_OVERLAP: { fail: "MEDIUM", review: "LOW" },
  DUPLICATE_IDENTITY: { fail: "HIGH", review: "MEDIUM" },
  IMPOSSIBLE_DOB_GRADUATION_AGE: { fail: "HIGH", review: "MEDIUM" },
};

const EDUCATION_SEQUENCE = ["SSC", "HSC", "Bachelor", "Masters"];

function outcome(
  check_type: FraudCheckType,
  status: "PASS" | "FAIL" | "NEEDS_REVIEW",
  reason_code: string,
  reason_description: string,
  evidence: Record<string, unknown>
): FraudCheckOutcome {
  const severity: FraudSeverity =
    status === "FAIL" ? DEFAULT_SEVERITY[check_type].fail : status === "NEEDS_REVIEW" ? DEFAULT_SEVERITY[check_type].review : "LOW";
  return { check_type, status, severity, reason_code, reason_description, evidence };
}

// ---------------------------------------------------------------------
// Check A: age vs education timeline inconsistency
// ---------------------------------------------------------------------
export function checkAgeEducationTimeline(
  profile: FraudCandidateProfile,
  config: AgeEducationTimelineConfig
): FraudCheckOutcome {
  if (!profile.date_of_birth) {
    return outcome(
      "AGE_EDUCATION_TIMELINE",
      "NEEDS_REVIEW",
      "AGE_EDUCATION_TIMELINE_DOB_MISSING",
      "Date of birth is missing, so age-at-graduation cannot be verified against education records.",
      { date_of_birth: null }
    );
  }

  const birthYear = new Date(profile.date_of_birth).getUTCFullYear();
  const withYear = profile.academic.filter((a) => a.passing_year !== null && a.level);

  if (withYear.length === 0) {
    return outcome(
      "AGE_EDUCATION_TIMELINE",
      "PASS",
      "AGE_EDUCATION_TIMELINE_NOT_APPLICABLE",
      "No academic records with a passing year are on file to check against date of birth.",
      { date_of_birth: profile.date_of_birth }
    );
  }

  const ageViolations: Array<Record<string, unknown>> = [];
  for (const a of withYear) {
    const minAge = config.min_age_by_level[a.level as string] ?? config.min_age_by_level.Other ?? 14;
    const ageAtPassing = (a.passing_year as number) - birthYear;
    if (!applyOperator(ageAtPassing, "GTE", minAge)) {
      ageViolations.push({
        level: a.level,
        passing_year: a.passing_year,
        age_at_passing_years: ageAtPassing,
        min_required_age_years: minAge,
      });
    }
  }

  const yearsByLevel: Record<string, number> = {};
  for (const a of withYear) {
    if (a.level && EDUCATION_SEQUENCE.includes(a.level) && a.passing_year !== null) {
      yearsByLevel[a.level] = a.passing_year;
    }
  }
  const sequenceViolations: Array<Record<string, unknown>> = [];
  for (let i = 1; i < EDUCATION_SEQUENCE.length; i++) {
    const prevLevel = EDUCATION_SEQUENCE[i - 1];
    const currLevel = EDUCATION_SEQUENCE[i];
    if (yearsByLevel[prevLevel] !== undefined && yearsByLevel[currLevel] !== undefined) {
      const gap = yearsByLevel[currLevel] - yearsByLevel[prevLevel];
      if (!applyOperator(gap, "GTE", config.min_level_gap_years)) {
        sequenceViolations.push({
          from_level: prevLevel,
          from_year: yearsByLevel[prevLevel],
          to_level: currLevel,
          to_year: yearsByLevel[currLevel],
          gap_years: gap,
          min_required_gap_years: config.min_level_gap_years,
        });
      }
    }
  }

  if (ageViolations.length > 0 || sequenceViolations.length > 0) {
    return outcome(
      "AGE_EDUCATION_TIMELINE",
      "FAIL",
      "AGE_EDUCATION_TIMELINE_INCONSISTENT",
      "The candidate's age at one or more education levels, or the gap between consecutive levels, falls outside plausible bounds.",
      { date_of_birth: profile.date_of_birth, birth_year: birthYear, age_violations: ageViolations, sequence_violations: sequenceViolations }
    );
  }

  return outcome(
    "AGE_EDUCATION_TIMELINE",
    "PASS",
    "AGE_EDUCATION_TIMELINE_CONSISTENT",
    "Age at each education level and the gaps between levels are within configured plausible bounds.",
    { date_of_birth: profile.date_of_birth, birth_year: birthYear, records_checked: withYear.length }
  );
}

// ---------------------------------------------------------------------
// Check B: CGPA vs division/class inconsistency
// ---------------------------------------------------------------------
function normalizeScale(resultScale: string | null): "scale_4" | "scale_5" | null {
  if (!resultScale) return null;
  if (resultScale.includes("5")) return "scale_5";
  if (resultScale.includes("4")) return "scale_4";
  return null;
}

export function checkCgpaDivisionConsistency(
  profile: FraudCandidateProfile,
  config: CgpaDivisionConsistencyConfig
): FraudCheckOutcome {
  // division_class of 'CGPA' means the result is reported purely on a
  // CGPA scale with no separate division/class label — nothing to
  // cross-check against.
  const relevant = profile.academic.filter((a) => a.cgpa !== null && a.division_class && a.division_class !== "CGPA");

  if (relevant.length === 0) {
    return outcome(
      "CGPA_DIVISION_CONSISTENCY",
      "PASS",
      "CGPA_DIVISION_NOT_APPLICABLE",
      "No academic record has both a CGPA and a division/class label to cross-check.",
      { records_checked: 0 }
    );
  }

  const mismatches: Array<Record<string, unknown>> = [];
  const unresolvedScale: Array<Record<string, unknown>> = [];

  for (const a of relevant) {
    const scaleKey = normalizeScale(a.result_scale);
    if (!scaleKey) {
      unresolvedScale.push({ level: a.level, result_scale: a.result_scale, cgpa: a.cgpa, division_class: a.division_class });
      continue;
    }
    const thresholds = config[scaleKey];
    const cgpa = a.cgpa as number;
    const expectedDivision =
      cgpa + config.tolerance >= thresholds.first_division_min_cgpa
        ? "First"
        : cgpa + config.tolerance >= thresholds.second_division_min_cgpa
        ? "Second"
        : "Third";
    if (expectedDivision !== a.division_class) {
      mismatches.push({
        level: a.level,
        cgpa,
        result_scale: a.result_scale,
        stated_division_class: a.division_class,
        expected_division_class: expectedDivision,
        thresholds_used: thresholds,
      });
    }
  }

  if (mismatches.length > 0) {
    return outcome(
      "CGPA_DIVISION_CONSISTENCY",
      "FAIL",
      "CGPA_DIVISION_MISMATCH",
      "The stated division/class does not match the division/class implied by the recorded CGPA on the same academic record.",
      { mismatches, unresolved_scale: unresolvedScale }
    );
  }

  if (unresolvedScale.length > 0) {
    return outcome(
      "CGPA_DIVISION_CONSISTENCY",
      "NEEDS_REVIEW",
      "CGPA_DIVISION_SCALE_UNKNOWN",
      "One or more academic records has a CGPA and division/class but an unrecognized result_scale, so consistency could not be verified automatically.",
      { unresolved_scale: unresolvedScale }
    );
  }

  return outcome(
    "CGPA_DIVISION_CONSISTENCY",
    "PASS",
    "CGPA_DIVISION_CONSISTENT",
    "Stated division/class matches the division/class implied by CGPA on every checkable academic record.",
    { records_checked: relevant.length }
  );
}

// ---------------------------------------------------------------------
// Check C: overlapping experience entries
// ---------------------------------------------------------------------
function experienceEnd(e: FraudExperienceEntry): Date {
  if (e.end_date) return new Date(e.end_date);
  if (e.is_current) return new Date();
  // No end date and not marked current: ambiguous data. Treat as a
  // zero-length window at start_date rather than guessing an end —
  // this can never itself manufacture a false overlap.
  return new Date(e.start_date as string);
}

export function checkExperienceOverlap(profile: FraudCandidateProfile, config: ExperienceOverlapConfig): FraudCheckOutcome {
  const entries = profile.experience.filter((e) => e.start_date);
  if (entries.length < 2) {
    return outcome(
      "EXPERIENCE_OVERLAP",
      "PASS",
      "EXPERIENCE_OVERLAP_NOT_APPLICABLE",
      "Fewer than two dated experience entries are on file, so overlap cannot occur.",
      { entries_checked: entries.length }
    );
  }

  const overlaps: Array<Record<string, unknown>> = [];
  let maxOverlapDays = 0;

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      const startA = new Date(a.start_date as string).getTime();
      const endA = experienceEnd(a).getTime();
      const startB = new Date(b.start_date as string).getTime();
      const endB = experienceEnd(b).getTime();
      const overlapMs = Math.min(endA, endB) - Math.max(startA, startB);
      const overlapDays = Math.floor(overlapMs / (1000 * 60 * 60 * 24));
      if (overlapDays > 0) {
        overlaps.push({
          entry_a: { organization: a.organization, designation: a.designation, start_date: a.start_date, end_date: a.end_date },
          entry_b: { organization: b.organization, designation: b.designation, start_date: b.start_date, end_date: b.end_date },
          overlap_days: overlapDays,
        });
        maxOverlapDays = Math.max(maxOverlapDays, overlapDays);
      }
    }
  }

  if (overlaps.length === 0) {
    return outcome(
      "EXPERIENCE_OVERLAP",
      "PASS",
      "EXPERIENCE_NO_OVERLAP",
      "No overlapping date ranges were found across the candidate's experience entries.",
      { entries_checked: entries.length }
    );
  }

  if (!applyOperator(maxOverlapDays, "LTE", config.max_allowed_overlap_days)) {
    return outcome(
      "EXPERIENCE_OVERLAP",
      "FAIL",
      "OVERLAPPING_EXPERIENCE_SUSPICIOUS",
      `One or more experience entries overlap by ${maxOverlapDays} day(s), exceeding the configured allowance of ${config.max_allowed_overlap_days} day(s).`,
      { overlaps, max_overlap_days: maxOverlapDays, max_allowed_overlap_days: config.max_allowed_overlap_days }
    );
  }

  return outcome(
    "EXPERIENCE_OVERLAP",
    "NEEDS_REVIEW",
    "OVERLAPPING_EXPERIENCE_MINOR",
    `A minor experience overlap of up to ${maxOverlapDays} day(s) was found — within the configured allowance but still worth a human glance (e.g. part-time/concurrent roles are legitimate).`,
    { overlaps, max_overlap_days: maxOverlapDays, max_allowed_overlap_days: config.max_allowed_overlap_days }
  );
}

// ---------------------------------------------------------------------
// Check D: duplicate NID/phone/email across candidates
// ---------------------------------------------------------------------
export function checkDuplicateIdentity(
  profile: FraudCandidateProfile,
  others: OtherCandidateIdentity[],
  config: DuplicateIdentityConfig
): FraudCheckOutcome {
  const matches: Array<Record<string, unknown>> = [];

  for (const other of others) {
    if (other.candidate_id === profile.candidate_id) continue;
    if (
      config.fields.includes("national_id") &&
      profile.national_id &&
      other.national_id &&
      other.national_id === profile.national_id
    ) {
      matches.push({ field: "national_id", value: profile.national_id, matched_candidate_id: other.candidate_id });
    }
    if (
      config.fields.includes("phone_primary") &&
      profile.phone_primary &&
      other.phone_primary &&
      other.phone_primary === profile.phone_primary
    ) {
      matches.push({ field: "phone_primary", value: profile.phone_primary, matched_candidate_id: other.candidate_id });
    }
    if (
      config.fields.includes("email") &&
      profile.email &&
      other.email &&
      other.email.toLowerCase() === profile.email.toLowerCase()
    ) {
      matches.push({ field: "email", value: profile.email.toLowerCase(), matched_candidate_id: other.candidate_id });
    }
  }

  if (matches.length === 0) {
    return outcome(
      "DUPLICATE_IDENTITY",
      "PASS",
      "NO_DUPLICATE_IDENTITY_FOUND",
      "No other candidate in this organization shares this candidate's national ID, primary phone number, or email address.",
      { fields_checked: config.fields }
    );
  }

  const matchedFields = Array.from(new Set(matches.map((m) => m.field as string)));
  const reasonCode = matchedFields.includes("national_id")
    ? "DUPLICATE_NATIONAL_ID"
    : matchedFields.includes("phone_primary")
    ? "DUPLICATE_PHONE_NUMBER"
    : "DUPLICATE_EMAIL";

  return outcome(
    "DUPLICATE_IDENTITY",
    "FAIL",
    reasonCode,
    `This candidate shares ${matchedFields.join(", ")} with ${new Set(matches.map((m) => m.matched_candidate_id)).size} other candidate(s) in the same organization.`,
    { matches }
  );
}

// ---------------------------------------------------------------------
// Check E: impossible graduation age / date-of-birth mismatches
// ---------------------------------------------------------------------
export function checkImpossibleDobGraduation(
  profile: FraudCandidateProfile,
  config: ImpossibleDobGraduationConfig
): FraudCheckOutcome {
  if (!profile.date_of_birth) {
    return outcome(
      "IMPOSSIBLE_DOB_GRADUATION_AGE",
      "NEEDS_REVIEW",
      "DOB_MISSING",
      "Date of birth is missing, so DOB/graduation plausibility cannot be verified.",
      { date_of_birth: null }
    );
  }

  const dob = new Date(profile.date_of_birth);
  const now = new Date();

  if (dob.getTime() > now.getTime()) {
    return outcome(
      "IMPOSSIBLE_DOB_GRADUATION_AGE",
      "FAIL",
      "DOB_FUTURE_DATE",
      "Date of birth is in the future, which is impossible.",
      { date_of_birth: profile.date_of_birth, evaluated_at: now.toISOString() }
    );
  }

  const ageYears = (now.getTime() - dob.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
  if (!applyOperator(ageYears, "LTE", config.max_plausible_age_years)) {
    return outcome(
      "IMPOSSIBLE_DOB_GRADUATION_AGE",
      "FAIL",
      "DOB_IMPLAUSIBLE_AGE",
      `Current age computed from date of birth (${ageYears.toFixed(1)} years) exceeds the configured plausible maximum of ${config.max_plausible_age_years} years.`,
      { date_of_birth: profile.date_of_birth, computed_age_years: Math.round(ageYears * 10) / 10, max_plausible_age_years: config.max_plausible_age_years }
    );
  }

  const birthYear = dob.getUTCFullYear();
  const impossible = profile.academic.filter((a) => a.passing_year !== null && (a.passing_year as number) <= birthYear);
  if (impossible.length > 0) {
    return outcome(
      "IMPOSSIBLE_DOB_GRADUATION_AGE",
      "FAIL",
      "GRADUATION_BEFORE_BIRTH",
      "One or more academic records show a passing year at or before the candidate's birth year, which is impossible.",
      { date_of_birth: profile.date_of_birth, birth_year: birthYear, impossible_records: impossible }
    );
  }

  return outcome(
    "IMPOSSIBLE_DOB_GRADUATION_AGE",
    "PASS",
    "DOB_GRADUATION_CONSISTENT",
    "Date of birth is plausible and precedes every recorded graduation year.",
    { date_of_birth: profile.date_of_birth, birth_year: birthYear }
  );
}

// ---------------------------------------------------------------------
// Effective check-set resolution: merges an org's explicit fraud_checks
// rows with system defaults for any check_type left unconfigured, so
// fraud detection works out of the box without mandatory setup while
// remaining fully overridable.
// ---------------------------------------------------------------------
export interface EffectiveFraudCheck {
  check_type: FraudCheckType;
  check_id: string | null; // null = using the system default, never explicitly configured
  config: Record<string, unknown>;
  is_knockout: boolean;
}

export function buildEffectiveChecks(orgChecks: FraudCheck[]): EffectiveFraudCheck[] {
  const byType = new Map(orgChecks.filter((c) => c.active).map((c) => [c.check_type, c]));
  const effective: EffectiveFraudCheck[] = [];
  for (const type of FRAUD_CHECK_TYPES) {
    const configured = byType.get(type);
    if (orgChecks.some((c) => c.check_type === type && !c.active) && !configured) {
      // Org explicitly disabled every active row for this type (a prior
      // active row was deactivated and never replaced) — skip entirely.
      continue;
    }
    if (configured) {
      effective.push({ check_type: type, check_id: configured.check_id, config: configured.config, is_knockout: configured.is_knockout });
    } else {
      effective.push({ check_type: type, check_id: null, config: DEFAULT_CHECK_CONFIGS[type] as unknown as Record<string, unknown>, is_knockout: false });
    }
  }
  return effective;
}

/**
 * Pure, deterministic core: given an assembled profile, the other
 * candidates relevant to duplicate-identity checking, and the
 * effective check set, run every check and return every outcome
 * (including PASS). No I/O, fully unit-testable in isolation.
 */
export function runFraudChecks(
  profile: FraudCandidateProfile,
  others: OtherCandidateIdentity[],
  effectiveChecks: EffectiveFraudCheck[]
): Array<FraudCheckOutcome & { check_id: string | null; is_knockout: boolean }> {
  return effectiveChecks.map((ec) => {
    let result: FraudCheckOutcome;
    switch (ec.check_type) {
      case "AGE_EDUCATION_TIMELINE":
        result = checkAgeEducationTimeline(profile, ec.config as unknown as AgeEducationTimelineConfig);
        break;
      case "CGPA_DIVISION_CONSISTENCY":
        result = checkCgpaDivisionConsistency(profile, ec.config as unknown as CgpaDivisionConsistencyConfig);
        break;
      case "EXPERIENCE_OVERLAP":
        result = checkExperienceOverlap(profile, ec.config as unknown as ExperienceOverlapConfig);
        break;
      case "DUPLICATE_IDENTITY":
        result = checkDuplicateIdentity(profile, others, ec.config as unknown as DuplicateIdentityConfig);
        break;
      case "IMPOSSIBLE_DOB_GRADUATION_AGE":
        result = checkImpossibleDobGraduation(profile, ec.config as unknown as ImpossibleDobGraduationConfig);
        break;
      /* istanbul ignore next -- FRAUD_CHECK_TYPES is exhaustive; guards against a future enum addition being silently skipped */
      default:
        throw new Error(`Unhandled fraud check_type: ${ec.check_type}`);
    }
    return { ...result, check_id: ec.check_id, is_knockout: ec.is_knockout };
  });
}

// ---------------------------------------------------------------------
// I/O: assembling the profile, loading config, finding duplicates,
// persisting flags, and orchestrating a single candidate / a batch.
// ---------------------------------------------------------------------

export async function assembleFraudProfile(candidateId: string, orgId: string): Promise<FraudCandidateProfile> {
  const [candidateRes, academicRes, experienceRes] = await Promise.all([
    db.query(`SELECT * FROM candidates WHERE candidate_id=$1 AND org_id=$2`, [candidateId, orgId]),
    db.query(`SELECT * FROM candidate_academic_records WHERE candidate_id=$1`, [candidateId]),
    db.query(`SELECT * FROM candidate_experience WHERE candidate_id=$1`, [candidateId]),
  ]);

  if (candidateRes.rowCount === 0) {
    throw new Error(`Candidate not found: ${candidateId}`);
  }
  const candidate = candidateRes.rows[0];

  const academic: FraudAcademicEntry[] = academicRes.rows.map((r: any) => ({
    level: r.level ?? null,
    passing_year: r.passing_year ?? null,
    division_class: r.division_class ?? null,
    cgpa: r.cgpa !== null && r.cgpa !== undefined ? Number(r.cgpa) : null,
    result_scale: r.result_scale ?? null,
  }));

  const experience: FraudExperienceEntry[] = experienceRes.rows.map((r: any) => ({
    organization: r.organization ?? null,
    designation: r.designation ?? null,
    start_date: r.start_date ?? null,
    end_date: r.end_date ?? null,
    is_current: r.is_current === true,
  }));

  return {
    candidate_id: candidate.candidate_id,
    org_id: candidate.org_id,
    full_name: candidate.full_name,
    date_of_birth: candidate.date_of_birth ?? null,
    national_id: candidate.national_id ?? null,
    phone_primary: candidate.phone_primary ?? null,
    email: candidate.email ?? null,
    academic,
    experience,
  };
}

async function loadOrgFraudChecks(orgId: string): Promise<FraudCheck[]> {
  const res = await db.query<FraudCheck>(`SELECT * FROM fraud_checks WHERE org_id=$1`, [orgId]);
  return res.rows;
}

/**
 * Targeted lookup for the duplicate-identity check: only fetches other
 * candidates in the same org that actually share a non-null national_id,
 * phone_primary, or (case-insensitive) email with this profile — never
 * a full-table scan, so this stays cheap at 100K+ candidates per org
 * (see idx_candidates_national_id/phone_primary/email in migration 0020).
 */
async function findMatchingOtherCandidates(profile: FraudCandidateProfile): Promise<OtherCandidateIdentity[]> {
  const conditions: string[] = [];
  const params: unknown[] = [profile.org_id, profile.candidate_id];
  let idx = params.length;

  if (profile.national_id) {
    params.push(profile.national_id);
    idx += 1;
    conditions.push(`national_id = $${idx}`);
  }
  if (profile.phone_primary) {
    params.push(profile.phone_primary);
    idx += 1;
    conditions.push(`phone_primary = $${idx}`);
  }
  if (profile.email) {
    params.push(profile.email.toLowerCase());
    idx += 1;
    conditions.push(`lower(email) = $${idx}`);
  }

  if (conditions.length === 0) {
    return [];
  }

  const res = await db.query(
    `SELECT candidate_id, national_id, phone_primary, email FROM candidates
     WHERE org_id=$1 AND candidate_id <> $2 AND (${conditions.join(" OR ")})`,
    params
  );
  return res.rows.map((r: any) => ({
    candidate_id: r.candidate_id,
    national_id: r.national_id ?? null,
    phone_primary: r.phone_primary ?? null,
    email: r.email ?? null,
  }));
}

/**
 * Full orchestration for one candidate: assemble profile -> resolve
 * effective checks -> find duplicate candidates -> run all deterministic
 * checks -> persist a fraud_flags row for every non-PASS outcome ->
 * audit every outcome (PASS included, per the Global Reasoning
 * Standard: "No result may exist without reasoning"). Never throws past
 * this point for a single candidate when called from the batch runner —
 * see runFraudDetectionBatch — but does throw here so a direct
 * single-candidate caller (e.g. an API route) sees the real error.
 */
export async function runFraudDetectionForCandidate(
  candidateId: string,
  orgId: string,
  actorUserId: string
): Promise<FraudDetectionCandidateResult> {
  const profile = await assembleFraudProfile(candidateId, orgId);
  const orgChecks = await loadOrgFraudChecks(orgId);
  const effectiveChecks = buildEffectiveChecks(orgChecks);
  const others = await findMatchingOtherCandidates(profile);

  const results = runFraudChecks(profile, others, effectiveChecks);

  const flagsCreated: FraudDetectionCandidateResult["flags_created"] = [];

  await db.withTransaction(async (client: PoolClient) => {
    for (const r of results) {
      if (r.status === "PASS") continue;
      const insertRes = await client.query(
        `INSERT INTO fraud_flags
          (org_id, candidate_id, check_id, check_type, severity, reason_code, reason_description, evidence, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'OPEN')
         RETURNING flag_id`,
        [orgId, candidateId, r.check_id, r.check_type, r.severity, r.reason_code, r.reason_description, JSON.stringify(r.evidence)]
      );
      flagsCreated.push({ check_type: r.check_type, status: r.status, reason_code: r.reason_code, flag_id: insertRes.rows[0].flag_id });
    }
  });

  // Every check outcome is audited, PASS included, so a PASS is exactly
  // as traceable as a flag — the Global Reasoning Standard applies to
  // clean results too, not only failures.
  for (const r of results) {
    await logAudit({
      org_id: orgId,
      entity_type: "FRAUD_CHECK",
      entity_id: candidateId,
      agent_or_user: actorUserId,
      action: `FRAUD_CHECK_${r.status}`,
      input_value: { check_type: r.check_type, check_id: r.check_id },
      output_value: { status: r.status, severity: r.severity },
      reason_code: r.reason_code,
      reason_comment: r.reason_description,
    });
  }

  return { candidate_id: candidateId, checks_run: results.length, flags_created: flagsCreated };
}

/**
 * Batch entry point: runs fraud detection across many candidates with
 * per-candidate error isolation — one candidate's missing data, missing
 * candidate row, or unexpected exception is captured on that
 * candidate's result and never aborts the rest of the batch. Suitable
 * for government/mass-recruitment volumes when called in bounded pages
 * from the API layer (see fraud.routes.ts POST /fraud/run).
 */
export async function runFraudDetectionBatch(
  candidateIds: string[],
  orgId: string,
  actorUserId: string
): Promise<FraudDetectionCandidateResult[]> {
  const results: FraudDetectionCandidateResult[] = [];
  for (const candidateId of candidateIds) {
    try {
      const result = await runFraudDetectionForCandidate(candidateId, orgId, actorUserId);
      results.push(result);
    } catch (err) {
      results.push({
        candidate_id: candidateId,
        checks_run: 0,
        flags_created: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
