import {
  addDaysToDate,
  expandTemplateChecklist,
  isStepOverdue,
} from "../../../src/agents/offboarding_agent";
import { OffboardingChecklistItem } from "../../../src/models/offboarding.model";

describe("addDaysToDate", () => {
  it("adds positive days to an exit date", () => {
    expect(addDaysToDate("2026-09-30", 7)).toBe("2026-10-07T00:00:00.000Z");
  });

  it("subtracts for negative offsets (due before exit)", () => {
    expect(addDaysToDate("2026-09-30", -3)).toBe("2026-09-27T00:00:00.000Z");
  });

  it("handles a zero offset (due on exit date)", () => {
    expect(addDaysToDate("2026-09-30", 0)).toBe("2026-09-30T00:00:00.000Z");
  });

  it("throws on a malformed date", () => {
    expect(() => addDaysToDate("not-a-date", 1)).toThrow(/Invalid exit_date/);
  });
});

describe("expandTemplateChecklist", () => {
  const CHECKLIST: OffboardingChecklistItem[] = [
    { item_code: "RETURN_LAPTOP", title: "Return laptop", category: "IT", default_due_days_from_exit: -3 },
    {
      item_code: "REVOKE_ACCESS",
      title: "Revoke system access",
      category: "IT",
      default_assignee_user_id: "user-it-1",
      default_due_days_from_exit: 0,
    },
    { item_code: "FINAL_SETTLEMENT", title: "Final settlement", category: "Finance", default_due_days_from_exit: 7 },
    { item_code: "EXIT_INTERVIEW", title: "Exit interview", category: "HR" },
  ];

  it("deterministically expands every checklist item into a step with a computed due date", () => {
    const result = expandTemplateChecklist(CHECKLIST, "2026-09-30");
    expect(result).toHaveLength(4);

    const laptop = result.find((r) => r.item_code === "RETURN_LAPTOP")!;
    expect(laptop.due_date).toBe("2026-09-27T00:00:00.000Z");
    expect(laptop.assigned_to).toBeNull();

    const access = result.find((r) => r.item_code === "REVOKE_ACCESS")!;
    expect(access.due_date).toBe("2026-09-30T00:00:00.000Z");
    expect(access.assigned_to).toBe("user-it-1");

    const settlement = result.find((r) => r.item_code === "FINAL_SETTLEMENT")!;
    expect(settlement.due_date).toBe("2026-10-07T00:00:00.000Z");

    // No default_due_days_from_exit specified => no due date, never guessed.
    const interview = result.find((r) => r.item_code === "EXIT_INTERVIEW")!;
    expect(interview.due_date).toBeNull();
    expect(interview.assigned_to).toBeNull();
  });

  it("is a pure function — same inputs always produce the same outputs", () => {
    const a = expandTemplateChecklist(CHECKLIST, "2026-09-30");
    const b = expandTemplateChecklist(CHECKLIST, "2026-09-30");
    expect(a).toEqual(b);
  });

  it("applies a per-case assignee override over the template default", () => {
    const result = expandTemplateChecklist(CHECKLIST, "2026-09-30", [
      { item_code: "REVOKE_ACCESS", assigned_to: "user-it-2" },
    ]);
    const access = result.find((r) => r.item_code === "REVOKE_ACCESS")!;
    expect(access.assigned_to).toBe("user-it-2");
  });

  it("applies a per-case due_date override over the computed default", () => {
    const result = expandTemplateChecklist(CHECKLIST, "2026-09-30", [
      { item_code: "RETURN_LAPTOP", due_date: "2026-09-25T00:00:00.000Z" },
    ]);
    const laptop = result.find((r) => r.item_code === "RETURN_LAPTOP")!;
    expect(laptop.due_date).toBe("2026-09-25T00:00:00.000Z");
  });

  it("allows an override to explicitly clear an assignee/due date with null", () => {
    const result = expandTemplateChecklist(CHECKLIST, "2026-09-30", [
      { item_code: "REVOKE_ACCESS", assigned_to: null, due_date: null },
    ]);
    const access = result.find((r) => r.item_code === "REVOKE_ACCESS")!;
    expect(access.assigned_to).toBeNull();
    expect(access.due_date).toBeNull();
  });

  it("preserves category as null when omitted, never undefined", () => {
    const result = expandTemplateChecklist(
      [{ item_code: "X", title: "No category step" }],
      "2026-09-30"
    );
    expect(result[0].category).toBeNull();
  });
});

describe("isStepOverdue", () => {
  const NOW = new Date("2026-09-30T12:00:00.000Z");

  it("is overdue when due_date is in the past and status is PENDING", () => {
    expect(isStepOverdue({ status: "PENDING", due_date: "2026-09-29T00:00:00.000Z" }, NOW)).toBe(true);
  });

  it("is overdue when due_date is in the past and status is IN_PROGRESS", () => {
    expect(isStepOverdue({ status: "IN_PROGRESS", due_date: "2026-09-01T00:00:00.000Z" }, NOW)).toBe(true);
  });

  it("is not overdue when due_date is in the future", () => {
    expect(isStepOverdue({ status: "PENDING", due_date: "2026-10-05T00:00:00.000Z" }, NOW)).toBe(false);
  });

  it("is not overdue when due_date is null (no deadline set)", () => {
    expect(isStepOverdue({ status: "PENDING", due_date: null }, NOW)).toBe(false);
  });

  it.each(["COMPLETED", "APPROVED", "REJECTED", "OVERDUE"])(
    "never flags a %s step as overdue again, even with a past due_date",
    (status) => {
      expect(isStepOverdue({ status, due_date: "2026-01-01T00:00:00.000Z" }, NOW)).toBe(false);
    }
  );

  it("defaults to the current system time when now is not supplied", () => {
    const pastDue = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString();
    expect(isStepOverdue({ status: "PENDING", due_date: pastDue })).toBe(true);
  });
});
