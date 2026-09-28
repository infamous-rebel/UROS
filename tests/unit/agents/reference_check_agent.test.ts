import { scoreQuestionResponse, computeReferenceScoring, RECOMMEND_THRESHOLD_PCT, CONCERN_THRESHOLD_PCT } from "../../../src/agents/reference_check_agent";
import { ReferenceQuestion } from "../../../src/models/reference.model";

const RATING: ReferenceQuestion = { question_id: "q_perf", text: "Rate performance", type: "RATING_1_5", weight: 50 };
const YESNO: ReferenceQuestion = { question_id: "q_rehire", text: "Would rehire?", type: "YES_NO", weight: 50 };
const TEXT: ReferenceQuestion = { question_id: "q_comments", text: "Comments?", type: "TEXT", weight: 0 };

describe("scoreQuestionResponse", () => {
  it("scores a valid RATING_1_5 response deterministically", () => {
    const outcome = scoreQuestionResponse(RATING, "4");
    expect(outcome.score).toBe(4);
    expect(outcome.confidence).toBe(1);
    expect(outcome.reason_code).toBe("REFERENCE_RATING_SCORED");
  });

  it("flags an out-of-range RATING_1_5 response as invalid / needs review", () => {
    const outcome = scoreQuestionResponse(RATING, "7");
    expect(outcome.score).toBeNull();
    expect(outcome.confidence).toBe(0);
    expect(outcome.reason_code).toBe("REFERENCE_RATING_INVALID");
  });

  it("flags a non-numeric RATING_1_5 response as invalid", () => {
    const outcome = scoreQuestionResponse(RATING, "good");
    expect(outcome.score).toBeNull();
    expect(outcome.reason_code).toBe("REFERENCE_RATING_INVALID");
  });

  it.each(["YES", "yes", "Y", "true"])("scores %s as a valid YES for YES_NO", (raw) => {
    const outcome = scoreQuestionResponse(YESNO, raw);
    expect(outcome.score).toBe(1);
    expect(outcome.confidence).toBe(1);
    expect(outcome.reason_code).toBe("REFERENCE_YESNO_SCORED");
  });

  it.each(["NO", "no", "N", "false"])("scores %s as a valid NO for YES_NO", (raw) => {
    const outcome = scoreQuestionResponse(YESNO, raw);
    expect(outcome.score).toBe(0);
    expect(outcome.confidence).toBe(1);
  });

  it("flags an unrecognized YES_NO response as invalid", () => {
    const outcome = scoreQuestionResponse(YESNO, "maybe");
    expect(outcome.score).toBeNull();
    expect(outcome.confidence).toBe(0);
    expect(outcome.reason_code).toBe("REFERENCE_YESNO_INVALID");
  });

  it("never auto-scores TEXT responses, even when present", () => {
    const outcome = scoreQuestionResponse(TEXT, "Great team player, highly recommend.");
    expect(outcome.score).toBeNull();
    expect(outcome.confidence).toBeNull();
    expect(outcome.reason_code).toBe("REFERENCE_TEXT_EVIDENCE_ONLY");
    expect(outcome.evidence.raw_response).toBe("Great team player, highly recommend.");
  });

  it("flags a missing response regardless of question type", () => {
    const outcome = scoreQuestionResponse(RATING, null);
    expect(outcome.score).toBeNull();
    expect(outcome.confidence).toBe(0);
    expect(outcome.reason_code).toBe("REFERENCE_RESPONSE_MISSING");
  });

  it("flags an empty-string response as missing", () => {
    const outcome = scoreQuestionResponse(YESNO, "   ");
    expect(outcome.reason_code).toBe("REFERENCE_RESPONSE_MISSING");
  });
});

describe("computeReferenceScoring", () => {
  const questions = [RATING, YESNO, TEXT];

  it("is deterministic: identical inputs always produce identical output", () => {
    const responses = [
      { question_id: "q_perf", response_text: "5" },
      { question_id: "q_rehire", response_text: "YES" },
      { question_id: "q_comments", response_text: "Excellent." },
    ];
    const first = computeReferenceScoring(questions, responses);
    const second = computeReferenceScoring(questions, responses);
    expect(second).toEqual(first);
  });

  it("normalizes scorable weights to a 100-point scale and computes a perfect score", () => {
    const responses = [
      { question_id: "q_perf", response_text: "5" },
      { question_id: "q_rehire", response_text: "YES" },
      { question_id: "q_comments", response_text: "Fine." },
    ];
    const outcome = computeReferenceScoring(questions, responses);
    expect(outcome.max_score).toBe(100);
    expect(outcome.total_score).toBeCloseTo(100, 5);
    expect(outcome.recommendation).toBe("RECOMMEND");
    expect(outcome.reason_code).toBe("REFERENCE_SCORE_ABOVE_THRESHOLD");
  });

  it("computes a partial score proportionally (rating 3/5, rehire NO)", () => {
    const responses = [
      { question_id: "q_perf", response_text: "3" },
      { question_id: "q_rehire", response_text: "NO" },
      { question_id: "q_comments", response_text: "Mixed." },
    ];
    const outcome = computeReferenceScoring(questions, responses);
    // RATING contributes 50 * (3/5) = 30; YES_NO contributes 50 * 0 = 0
    expect(outcome.total_score).toBeCloseTo(30, 5);
    expect(outcome.recommendation).toBe("CONCERN");
    expect(outcome.reason_code).toBe("REFERENCE_SCORE_BELOW_THRESHOLD");
  });

  it("forces NEEDS_REVIEW when any scorable question is missing or invalid, regardless of score", () => {
    const responses = [
      { question_id: "q_perf", response_text: "5" },
      { question_id: "q_rehire", response_text: "" }, // missing
      { question_id: "q_comments", response_text: "Great." },
    ];
    const outcome = computeReferenceScoring(questions, responses);
    expect(outcome.recommendation).toBe("NEEDS_REVIEW");
    expect(outcome.reason_code).toBe("REFERENCE_INCOMPLETE_RESPONSES");
  });

  it("returns NEEDS_REVIEW with zero max_score when the question set has no scorable questions", () => {
    const outcome = computeReferenceScoring([TEXT], [{ question_id: "q_comments", response_text: "Only text." }]);
    expect(outcome.max_score).toBe(0);
    expect(outcome.total_score).toBe(0);
    expect(outcome.recommendation).toBe("NEEDS_REVIEW");
    expect(outcome.reason_code).toBe("REFERENCE_NO_SCORABLE_QUESTIONS");
  });

  it("lands in the mid-range band between concern and recommend thresholds", () => {
    // Construct a response that yields a score strictly between the two thresholds.
    const midQuestions: ReferenceQuestion[] = [{ question_id: "q_only", text: "Rate", type: "RATING_1_5", weight: 100 }];
    const responses = [{ question_id: "q_only", response_text: "3" }]; // 3/5 * 100 = 60
    const outcome = computeReferenceScoring(midQuestions, responses);
    expect(outcome.total_score).toBeCloseTo(60, 5);
    expect(60).toBeGreaterThanOrEqual(CONCERN_THRESHOLD_PCT);
    expect(60).toBeLessThan(RECOMMEND_THRESHOLD_PCT);
    expect(outcome.recommendation).toBe("NEEDS_REVIEW");
    expect(outcome.reason_code).toBe("REFERENCE_SCORE_MID_RANGE");
  });

  it("never lets a TEXT question contribute to total_score or max_score", () => {
    const onlyTextAndRating: ReferenceQuestion[] = [
      { question_id: "q_perf", text: "Rate", type: "RATING_1_5", weight: 100 },
      { question_id: "q_comments", text: "Comments", type: "TEXT", weight: 9999 },
    ];
    const outcome = computeReferenceScoring(onlyTextAndRating, [
      { question_id: "q_perf", response_text: "5" },
      { question_id: "q_comments", response_text: "Whatever text, huge weight ignored." },
    ]);
    expect(outcome.max_score).toBe(100);
    expect(outcome.total_score).toBeCloseTo(100, 5);
  });
});
