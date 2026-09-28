import {
  checkAgeEducationTimeline,
  checkCgpaDivisionConsistency,
  checkExperienceOverlap,
  checkDuplicateIdentity,
  checkImpossibleDobGraduation,
  buildEffectiveChecks,
  runFraudChecks,
  DEFAULT_CHECK_CONFIGS,
} from "../../../src/agents/fraud_detection_agent";
import { FraudCandidateProfile, FraudCheck, OtherCandidateIdentity } from "../../../src/models/fraud.model";

function baseProfile(overrides: Partial<FraudCandidateProfile> = {}): FraudCandidateProfile {
  return {
    candidate_id: "UROS-TEST-0001",
    org_id: "org-1",
    full_name: "Test Candidate",
    date_of_birth: "1990-01-01",
    national_id: "NID-100",
    phone_primary: "01711111111",
    email: "candidate@example.com",
    academic: [],
    experience: [],
    ...overrides,
  };
}

describe("checkAgeEducationTimeline", () => {
  const config = DEFAULT_CHECK_CONFIGS.AGE_EDUCATION_TIMELINE;

  it("PASSes a plausible, ascending education timeline", () => {
    const profile = baseProfile({
      date_of_birth: "1990-01-01",
      academic: [
        { level: "SSC", passing_year: 2005, division_class: "First", cgpa: null, result_scale: null },
        { level: "HSC", passing_year: 2007, division_class: "First", cgpa: null, result_scale: null },
        { level: "Bachelor", passing_year: 2011, division_class: "First", cgpa: 3.8, result_scale: "out of 4" },
      ],
    });
    const result = checkAgeEducationTimeline(profile, config);
    expect(result.status).toBe("PASS");
    expect(result.reason_code).toBe("AGE_EDUCATION_TIMELINE_CONSISTENT");
  });

  it("FAILs when a candidate is implausibly young at a level", () => {
    const profile = baseProfile({
      date_of_birth: "2005-01-01",
      academic: [{ level: "Bachelor", passing_year: 2011, division_class: "First", cgpa: 3.5, result_scale: "out of 4" }],
    });
    const result = checkAgeEducationTimeline(profile, config);
    expect(result.status).toBe("FAIL");
    expect(result.reason_code).toBe("AGE_EDUCATION_TIMELINE_INCONSISTENT");
    expect(result.evidence.age_violations).toHaveLength(1);
  });

  it("FAILs when consecutive levels are passed too close together", () => {
    const profile = baseProfile({
      date_of_birth: "1990-01-01",
      academic: [
        { level: "SSC", passing_year: 2010, division_class: "First", cgpa: null, result_scale: null },
        { level: "HSC", passing_year: 2010, division_class: "First", cgpa: null, result_scale: null },
      ],
    });
    const result = checkAgeEducationTimeline(profile, config);
    expect(result.status).toBe("FAIL");
    expect((result.evidence.sequence_violations as unknown[]).length).toBeGreaterThan(0);
  });

  it("returns NEEDS_REVIEW when date of birth is missing", () => {
    const profile = baseProfile({ date_of_birth: null, academic: [{ level: "SSC", passing_year: 2010, division_class: "First", cgpa: null, result_scale: null }] });
    const result = checkAgeEducationTimeline(profile, config);
    expect(result.status).toBe("NEEDS_REVIEW");
    expect(result.reason_code).toBe("AGE_EDUCATION_TIMELINE_DOB_MISSING");
  });

  it("PASSes as not-applicable when there are no dated academic records", () => {
    const profile = baseProfile({ academic: [] });
    const result = checkAgeEducationTimeline(profile, config);
    expect(result.status).toBe("PASS");
    expect(result.reason_code).toBe("AGE_EDUCATION_TIMELINE_NOT_APPLICABLE");
  });

  it("is deterministic", () => {
    const profile = baseProfile({
      academic: [{ level: "Bachelor", passing_year: 2011, division_class: "First", cgpa: 3.5, result_scale: "out of 4" }],
    });
    expect(checkAgeEducationTimeline(profile, config)).toEqual(checkAgeEducationTimeline(profile, config));
  });
});

describe("checkCgpaDivisionConsistency", () => {
  const config = DEFAULT_CHECK_CONFIGS.CGPA_DIVISION_CONSISTENCY;

  it("PASSes when stated division matches the CGPA-implied division (scale of 4)", () => {
    const profile = baseProfile({
      academic: [{ level: "Bachelor", passing_year: 2011, division_class: "First", cgpa: 3.5, result_scale: "out of 4" }],
    });
    const result = checkCgpaDivisionConsistency(profile, config);
    expect(result.status).toBe("PASS");
    expect(result.reason_code).toBe("CGPA_DIVISION_CONSISTENT");
  });

  it("FAILs when a low CGPA is stated as First Division (scale of 5)", () => {
    const profile = baseProfile({
      academic: [{ level: "HSC", passing_year: 2007, division_class: "First", cgpa: 2.0, result_scale: "out of 5" }],
    });
    const result = checkCgpaDivisionConsistency(profile, config);
    expect(result.status).toBe("FAIL");
    expect(result.reason_code).toBe("CGPA_DIVISION_MISMATCH");
    expect(result.evidence.mismatches).toHaveLength(1);
  });

  it("returns NEEDS_REVIEW for an unrecognized result_scale", () => {
    const profile = baseProfile({
      academic: [{ level: "HSC", passing_year: 2007, division_class: "First", cgpa: 4.5, result_scale: "percentage" }],
    });
    const result = checkCgpaDivisionConsistency(profile, config);
    expect(result.status).toBe("NEEDS_REVIEW");
    expect(result.reason_code).toBe("CGPA_DIVISION_SCALE_UNKNOWN");
  });

  it("PASSes as not-applicable when division_class is 'CGPA' (no separate label to check)", () => {
    const profile = baseProfile({
      academic: [{ level: "Bachelor", passing_year: 2011, division_class: "CGPA", cgpa: 3.5, result_scale: "out of 4" }],
    });
    const result = checkCgpaDivisionConsistency(profile, config);
    expect(result.status).toBe("PASS");
    expect(result.reason_code).toBe("CGPA_DIVISION_NOT_APPLICABLE");
  });

  it("is deterministic", () => {
    const profile = baseProfile({
      academic: [{ level: "HSC", passing_year: 2007, division_class: "First", cgpa: 2.0, result_scale: "out of 5" }],
    });
    expect(checkCgpaDivisionConsistency(profile, config)).toEqual(checkCgpaDivisionConsistency(profile, config));
  });
});

describe("checkExperienceOverlap", () => {
  const config = DEFAULT_CHECK_CONFIGS.EXPERIENCE_OVERLAP;

  it("PASSes with no overlapping experience", () => {
    const profile = baseProfile({
      experience: [
        { organization: "Org A", designation: "Officer", start_date: "2018-01-01", end_date: "2019-01-01", is_current: false },
        { organization: "Org B", designation: "Officer", start_date: "2019-02-01", end_date: "2020-01-01", is_current: false },
      ],
    });
    const result = checkExperienceOverlap(profile, config);
    expect(result.status).toBe("PASS");
    expect(result.reason_code).toBe("EXPERIENCE_NO_OVERLAP");
  });

  it("FAILs with a large suspicious overlap exceeding the configured allowance", () => {
    const profile = baseProfile({
      experience: [
        { organization: "Org A", designation: "Officer", start_date: "2018-01-01", end_date: "2020-01-01", is_current: false },
        { organization: "Org B", designation: "Manager", start_date: "2018-06-01", end_date: "2019-06-01", is_current: false },
      ],
    });
    const result = checkExperienceOverlap(profile, config);
    expect(result.status).toBe("FAIL");
    expect(result.reason_code).toBe("OVERLAPPING_EXPERIENCE_SUSPICIOUS");
  });

  it("returns NEEDS_REVIEW for a minor overlap within the configured allowance", () => {
    const profile = baseProfile({
      experience: [
        { organization: "Org A", designation: "Officer", start_date: "2018-01-01", end_date: "2019-01-10", is_current: false },
        { organization: "Org B", designation: "Consultant", start_date: "2019-01-01", end_date: "2019-06-01", is_current: false },
      ],
    });
    const result = checkExperienceOverlap(profile, config);
    expect(result.status).toBe("NEEDS_REVIEW");
    expect(result.reason_code).toBe("OVERLAPPING_EXPERIENCE_MINOR");
  });

  it("PASSes as not-applicable with fewer than two dated entries", () => {
    const profile = baseProfile({ experience: [{ organization: "Org A", designation: "Officer", start_date: "2018-01-01", end_date: null, is_current: true }] });
    const result = checkExperienceOverlap(profile, config);
    expect(result.status).toBe("PASS");
    expect(result.reason_code).toBe("EXPERIENCE_OVERLAP_NOT_APPLICABLE");
  });

  it("is deterministic", () => {
    const profile = baseProfile({
      experience: [
        { organization: "Org A", designation: "Officer", start_date: "2018-01-01", end_date: "2020-01-01", is_current: false },
        { organization: "Org B", designation: "Manager", start_date: "2018-06-01", end_date: "2019-06-01", is_current: false },
      ],
    });
    expect(checkExperienceOverlap(profile, config)).toEqual(checkExperienceOverlap(profile, config));
  });
});

describe("checkDuplicateIdentity", () => {
  const config = DEFAULT_CHECK_CONFIGS.DUPLICATE_IDENTITY;

  it("PASSes when no other candidate shares an identity field", () => {
    const profile = baseProfile();
    const result = checkDuplicateIdentity(profile, [], config);
    expect(result.status).toBe("PASS");
    expect(result.reason_code).toBe("NO_DUPLICATE_IDENTITY_FOUND");
  });

  it("FAILs on a shared national_id", () => {
    const profile = baseProfile({ national_id: "NID-100" });
    const others: OtherCandidateIdentity[] = [{ candidate_id: "UROS-TEST-0002", national_id: "NID-100", phone_primary: null, email: null }];
    const result = checkDuplicateIdentity(profile, others, config);
    expect(result.status).toBe("FAIL");
    expect(result.reason_code).toBe("DUPLICATE_NATIONAL_ID");
    expect(result.severity).toBe("HIGH");
  });

  it("FAILs on a shared email, case-insensitively", () => {
    const profile = baseProfile({ national_id: null, phone_primary: null, email: "Candidate@Example.com" });
    const others: OtherCandidateIdentity[] = [{ candidate_id: "UROS-TEST-0002", national_id: null, phone_primary: null, email: "candidate@example.com" }];
    const result = checkDuplicateIdentity(profile, others, config);
    expect(result.status).toBe("FAIL");
    expect(result.reason_code).toBe("DUPLICATE_EMAIL");
  });

  it("never matches itself even if passed in the others list", () => {
    const profile = baseProfile();
    const others: OtherCandidateIdentity[] = [{ candidate_id: profile.candidate_id, national_id: profile.national_id, phone_primary: profile.phone_primary, email: profile.email }];
    const result = checkDuplicateIdentity(profile, others, config);
    expect(result.status).toBe("PASS");
  });

  it("is deterministic", () => {
    const profile = baseProfile();
    const others: OtherCandidateIdentity[] = [{ candidate_id: "UROS-TEST-0002", national_id: "NID-100", phone_primary: null, email: null }];
    expect(checkDuplicateIdentity(profile, others, config)).toEqual(checkDuplicateIdentity(profile, others, config));
  });
});

describe("checkImpossibleDobGraduation", () => {
  const config = DEFAULT_CHECK_CONFIGS.IMPOSSIBLE_DOB_GRADUATION_AGE;

  it("PASSes a plausible date of birth with graduation after birth", () => {
    const profile = baseProfile({ date_of_birth: "1990-01-01", academic: [{ level: "Bachelor", passing_year: 2011, division_class: "First", cgpa: 3.5, result_scale: "out of 4" }] });
    const result = checkImpossibleDobGraduation(profile, config);
    expect(result.status).toBe("PASS");
    expect(result.reason_code).toBe("DOB_GRADUATION_CONSISTENT");
  });

  it("FAILs on a future date of birth", () => {
    const future = new Date();
    future.setFullYear(future.getFullYear() + 5);
    const profile = baseProfile({ date_of_birth: future.toISOString().slice(0, 10) });
    const result = checkImpossibleDobGraduation(profile, config);
    expect(result.status).toBe("FAIL");
    expect(result.reason_code).toBe("DOB_FUTURE_DATE");
  });

  it("FAILs on an implausibly old date of birth", () => {
    const profile = baseProfile({ date_of_birth: "1900-01-01" });
    const result = checkImpossibleDobGraduation(profile, config);
    expect(result.status).toBe("FAIL");
    expect(result.reason_code).toBe("DOB_IMPLAUSIBLE_AGE");
  });

  it("FAILs when a graduation year is at or before the birth year", () => {
    const profile = baseProfile({
      date_of_birth: "1990-01-01",
      academic: [{ level: "SSC", passing_year: 1988, division_class: "First", cgpa: null, result_scale: null }],
    });
    const result = checkImpossibleDobGraduation(profile, config);
    expect(result.status).toBe("FAIL");
    expect(result.reason_code).toBe("GRADUATION_BEFORE_BIRTH");
  });

  it("returns NEEDS_REVIEW when date of birth is missing", () => {
    const profile = baseProfile({ date_of_birth: null });
    const result = checkImpossibleDobGraduation(profile, config);
    expect(result.status).toBe("NEEDS_REVIEW");
    expect(result.reason_code).toBe("DOB_MISSING");
  });

  it("is deterministic", () => {
    const profile = baseProfile({ date_of_birth: "1900-01-01" });
    expect(checkImpossibleDobGraduation(profile, config)).toEqual(checkImpossibleDobGraduation(profile, config));
  });
});

describe("buildEffectiveChecks / runFraudChecks", () => {
  it("uses system defaults for every check type when the org has configured nothing", () => {
    const effective = buildEffectiveChecks([]);
    expect(effective).toHaveLength(5);
    expect(effective.every((c) => c.check_id === null)).toBe(true);
  });

  it("uses an org's active configuration in place of the system default for that check type", () => {
    const orgChecks: FraudCheck[] = [
      {
        check_id: "check-1",
        org_id: "org-1",
        name: "Custom overlap tolerance",
        check_type: "EXPERIENCE_OVERLAP",
        config: { max_allowed_overlap_days: 5 },
        is_knockout: false,
        active: true,
        created_by: "user-1",
        created_at: new Date().toISOString(),
      },
    ];
    const effective = buildEffectiveChecks(orgChecks);
    const overlap = effective.find((c) => c.check_type === "EXPERIENCE_OVERLAP")!;
    expect(overlap.check_id).toBe("check-1");
    expect(overlap.config).toEqual({ max_allowed_overlap_days: 5 });
  });

  it("skips a check type an org has explicitly deactivated with no replacement", () => {
    const orgChecks: FraudCheck[] = [
      {
        check_id: "check-1",
        org_id: "org-1",
        name: "Disabled",
        check_type: "EXPERIENCE_OVERLAP",
        config: {},
        is_knockout: false,
        active: false,
        created_by: "user-1",
        created_at: new Date().toISOString(),
      },
    ];
    const effective = buildEffectiveChecks(orgChecks);
    expect(effective.find((c) => c.check_type === "EXPERIENCE_OVERLAP")).toBeUndefined();
    expect(effective).toHaveLength(4);
  });

  it("runs every effective check and returns one outcome per check, carrying check_id/is_knockout through", () => {
    const profile = baseProfile();
    const effective = buildEffectiveChecks([]);
    const results = runFraudChecks(profile, [], effective);
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.reason_code).toBeTruthy();
      expect(r.reason_description).toBeTruthy();
      expect(r.evidence).toBeDefined();
      expect(["PASS", "FAIL", "NEEDS_REVIEW"]).toContain(r.status);
    }
  });
});
