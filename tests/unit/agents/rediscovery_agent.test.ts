import {
  filterEligibleCandidates,
  CandidatePoolRow,
  resolveConsentStatus,
  daysBetween,
  computeCutoffIso,
  buildSuggestionReason,
  generateConsentToken,
  verifyConsentToken,
  computeConsentTokenWithSecret,
} from "../../../src/agents/rediscovery_agent";

function candidate(id: string, overrides: Partial<CandidatePoolRow> = {}): CandidatePoolRow {
  return {
    candidate_id: id,
    status: "REJECTED",
    updated_at: "2026-01-01T00:00:00.000Z",
    job_circular_id: "CIRC-OLD",
    position_applied: "Officer",
    ...overrides,
  };
}

describe("filterEligibleCandidates", () => {
  const cutoffIso = "2026-06-01T00:00:00.000Z";

  it("passes a candidate with no exclusions and an explicit opt-in", () => {
    const result = filterEligibleCandidates({
      candidates: [candidate("C1", { updated_at: "2026-01-01T00:00:00.000Z" })],
      fraudFlaggedIds: new Set(),
      consentByCandidate: new Map([["C1", true]]),
      alreadySuggestedIds: new Set(),
      requireOptIn: true,
      cutoffIso,
    });
    expect(result.eligible.map((c) => c.candidate_id)).toEqual(["C1"]);
    expect(result.excludedAlreadySuggested).toEqual([]);
    expect(result.excludedRecent).toEqual([]);
    expect(result.excludedFraud).toEqual([]);
    expect(result.excludedConsent).toEqual([]);
  });

  it("excludes a candidate already suggested for this circular, even if otherwise eligible", () => {
    const result = filterEligibleCandidates({
      candidates: [candidate("C1")],
      fraudFlaggedIds: new Set(),
      consentByCandidate: new Map([["C1", true]]),
      alreadySuggestedIds: new Set(["C1"]),
      requireOptIn: true,
      cutoffIso,
    });
    expect(result.eligible).toEqual([]);
    expect(result.excludedAlreadySuggested).toEqual(["C1"]);
  });

  it("excludes a candidate whose last update is more recent than the cooldown cutoff", () => {
    const result = filterEligibleCandidates({
      candidates: [candidate("C1", { updated_at: "2026-08-01T00:00:00.000Z" })],
      fraudFlaggedIds: new Set(),
      consentByCandidate: new Map([["C1", true]]),
      alreadySuggestedIds: new Set(),
      requireOptIn: true,
      cutoffIso,
    });
    expect(result.eligible).toEqual([]);
    expect(result.excludedRecent).toEqual(["C1"]);
  });

  it("excludes a candidate with an open fraud flag even if opted in and outside cooldown", () => {
    const result = filterEligibleCandidates({
      candidates: [candidate("C1")],
      fraudFlaggedIds: new Set(["C1"]),
      consentByCandidate: new Map([["C1", true]]),
      alreadySuggestedIds: new Set(),
      requireOptIn: true,
      cutoffIso,
    });
    expect(result.eligible).toEqual([]);
    expect(result.excludedFraud).toEqual(["C1"]);
  });

  it("excludes a candidate who explicitly opted out, regardless of requireOptIn", () => {
    const requireTrue = filterEligibleCandidates({
      candidates: [candidate("C1")],
      fraudFlaggedIds: new Set(),
      consentByCandidate: new Map([["C1", false]]),
      alreadySuggestedIds: new Set(),
      requireOptIn: true,
      cutoffIso,
    });
    const requireFalse = filterEligibleCandidates({
      candidates: [candidate("C1")],
      fraudFlaggedIds: new Set(),
      consentByCandidate: new Map([["C1", false]]),
      alreadySuggestedIds: new Set(),
      requireOptIn: false,
      cutoffIso,
    });
    expect(requireTrue.excludedConsent).toEqual(["C1"]);
    expect(requireFalse.excludedConsent).toEqual(["C1"]);
  });

  it("excludes a candidate with no consent record when requireOptIn is true", () => {
    const result = filterEligibleCandidates({
      candidates: [candidate("C1")],
      fraudFlaggedIds: new Set(),
      consentByCandidate: new Map(),
      alreadySuggestedIds: new Set(),
      requireOptIn: true,
      cutoffIso,
    });
    expect(result.eligible).toEqual([]);
    expect(result.excludedConsent).toEqual(["C1"]);
  });

  it("includes a candidate with no consent record when requireOptIn is false", () => {
    const result = filterEligibleCandidates({
      candidates: [candidate("C1")],
      fraudFlaggedIds: new Set(),
      consentByCandidate: new Map(),
      alreadySuggestedIds: new Set(),
      requireOptIn: false,
      cutoffIso,
    });
    expect(result.eligible.map((c) => c.candidate_id)).toEqual(["C1"]);
  });

  it("applies exclusion priority order: already-suggested beats every other reason", () => {
    const result = filterEligibleCandidates({
      candidates: [candidate("C1", { updated_at: "2026-08-01T00:00:00.000Z" })],
      fraudFlaggedIds: new Set(["C1"]),
      consentByCandidate: new Map([["C1", false]]),
      alreadySuggestedIds: new Set(["C1"]),
      requireOptIn: true,
      cutoffIso,
    });
    expect(result.excludedAlreadySuggested).toEqual(["C1"]);
    expect(result.excludedRecent).toEqual([]);
    expect(result.excludedFraud).toEqual([]);
    expect(result.excludedConsent).toEqual([]);
  });

  it("buckets a mixed batch deterministically and every candidate lands in exactly one bucket", () => {
    const candidates = [
      candidate("ELIGIBLE", { updated_at: "2026-01-01T00:00:00.000Z" }),
      candidate("RECENT", { updated_at: "2026-08-01T00:00:00.000Z" }),
      candidate("FRAUD", { updated_at: "2026-01-01T00:00:00.000Z" }),
      candidate("OPTED_OUT", { updated_at: "2026-01-01T00:00:00.000Z" }),
      candidate("ALREADY", { updated_at: "2026-01-01T00:00:00.000Z" }),
    ];
    const result = filterEligibleCandidates({
      candidates,
      fraudFlaggedIds: new Set(["FRAUD"]),
      consentByCandidate: new Map([
        ["ELIGIBLE", true],
        ["FRAUD", true],
        ["OPTED_OUT", false],
        ["ALREADY", true],
      ]),
      alreadySuggestedIds: new Set(["ALREADY"]),
      requireOptIn: true,
      cutoffIso,
    });
    expect(result.eligible.map((c) => c.candidate_id)).toEqual(["ELIGIBLE"]);
    expect(result.excludedAlreadySuggested).toEqual(["ALREADY"]);
    expect(result.excludedRecent).toEqual(["RECENT"]);
    expect(result.excludedFraud).toEqual(["FRAUD"]);
    expect(result.excludedConsent).toEqual(["OPTED_OUT"]);
    const total =
      result.eligible.length +
      result.excludedAlreadySuggested.length +
      result.excludedRecent.length +
      result.excludedFraud.length +
      result.excludedConsent.length;
    expect(total).toBe(candidates.length);
  });
});

describe("resolveConsentStatus", () => {
  it("maps true/false/undefined to OPTED_IN/OPTED_OUT/NO_RECORD", () => {
    expect(resolveConsentStatus(true)).toBe("OPTED_IN");
    expect(resolveConsentStatus(false)).toBe("OPTED_OUT");
    expect(resolveConsentStatus(undefined)).toBe("NO_RECORD");
  });
});

describe("daysBetween", () => {
  it("computes whole days between two ISO timestamps", () => {
    expect(daysBetween("2026-01-01T00:00:00.000Z", "2026-01-11T00:00:00.000Z")).toBe(10);
  });
  it("never returns a negative number", () => {
    expect(daysBetween("2026-01-11T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).toBe(0);
  });
  it("floors partial days", () => {
    expect(daysBetween("2026-01-01T00:00:00.000Z", "2026-01-02T12:00:00.000Z")).toBe(1);
  });
});

describe("computeCutoffIso", () => {
  it("subtracts the given number of days from now", () => {
    const cutoff = computeCutoffIso("2026-06-01T00:00:00.000Z", 90);
    expect(cutoff).toBe("2026-03-03T00:00:00.000Z");
  });
  it("returns the same instant for zero days", () => {
    expect(computeCutoffIso("2026-06-01T00:00:00.000Z", 0)).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("buildSuggestionReason", () => {
  it("produces a stable reason_code and a descriptive reason_description", () => {
    const result = buildSuggestionReason(82.5, "Relationship Manager", "Senior Officer", "BSC-2027-01", 4, 5);
    expect(result.reason_code).toBe("REDISCOVERY_MATCH_SUGGESTED");
    expect(result.reason_description).toContain("82.5/100");
    expect(result.reason_description).toContain("Relationship Manager");
    expect(result.reason_description).toContain("Senior Officer");
    expect(result.reason_description).toContain("BSC-2027-01");
    expect(result.reason_description).toContain("4/5");
  });

  it("falls back to a generic phrase when target_position is null", () => {
    const result = buildSuggestionReason(60, "Persona", null, "CIRC-1", 1, 2);
    expect(result.reason_description).toContain("the position");
  });
});

describe("consent token generation/verification", () => {
  it("generates a 64-character hex token deterministically for the same candidate and secret", () => {
    const a = computeConsentTokenWithSecret("UROS-2026-0001", "secret-a");
    const b = computeConsentTokenWithSecret("UROS-2026-0001", "secret-a");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces different tokens for different candidates or different secrets", () => {
    const a = computeConsentTokenWithSecret("UROS-2026-0001", "secret-a");
    const b = computeConsentTokenWithSecret("UROS-2026-0002", "secret-a");
    const c = computeConsentTokenWithSecret("UROS-2026-0001", "secret-b");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("verifies a token generated by generateConsentToken for the same candidate", () => {
    const token = generateConsentToken("UROS-2026-0001");
    expect(verifyConsentToken("UROS-2026-0001", token)).toBe(true);
  });

  it("rejects a token generated for a different candidate", () => {
    const token = generateConsentToken("UROS-2026-0001");
    expect(verifyConsentToken("UROS-2026-0002", token)).toBe(false);
  });

  it("rejects a malformed token without throwing", () => {
    expect(verifyConsentToken("UROS-2026-0001", "not-a-valid-token")).toBe(false);
    expect(verifyConsentToken("UROS-2026-0001", "")).toBe(false);
  });
});
