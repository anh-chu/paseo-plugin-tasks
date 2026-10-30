import { describe, expect, it } from "vitest";
import { reviewEvidenceVerdict } from "../server/review-evidence";
const hasReviewEvidence = (...args: Parameters<typeof reviewEvidenceVerdict>) => reviewEvidenceVerdict(...args) !== null;

const evidence = (key: string, verdict: string, ran = "Tests passed", gaps = "None") =>
  `**Evidence for \`${key}\`** — ${verdict}\n\n**What ran**\n${ran}\n\n**What was not covered**\n${gaps}`;
const user = (body: string) => ({ kind: "user", body });

describe("review evidence", () => {
  it.each(["PASS", "PASS WITH GAPS", "FAILED CHECK", "NOTHING CHECKABLE", "BLOCKED"])("accepts %s with results and gaps", (verdict) => {
    expect(hasReviewEvidence([user(evidence("TASKS-1", verdict))], "TASKS-1")).toBe(true);
  });
  it("requires the right task, a verdict on its heading, and nonempty sections", () => {
    expect(hasReviewEvidence([user(evidence("OTHER-1", "PASS"))], "TASKS-1")).toBe(false);
    expect(hasReviewEvidence([user(`Previous — PASS\n${evidence("TASKS-1", "FAILED CHECK").replace(" — FAILED CHECK", "")}`)], "TASKS-1")).toBe(false);
    expect(hasReviewEvidence([user(evidence("TASKS-1", "PASS", "", "None"))], "TASKS-1")).toBe(false);
    expect(hasReviewEvidence([user(evidence("TASKS-1", "PASS", "Done", ""))], "TASKS-1")).toBe(false);
  });
  it("does not reuse evidence after the card returns to an active state", () => {
    const old = user(evidence("TASKS-1", "PASS"));
    const reopened = { kind: "system", body: "Status changed to In Progress by You" };
    expect(hasReviewEvidence([old, reopened], "TASKS-1")).toBe(false);
    expect(hasReviewEvidence([old, reopened, user(evidence("TASKS-1", "BLOCKED"))], "TASKS-1")).toBe(true);
    expect(hasReviewEvidence([old, { kind: "system", body: "Dispatched to agent" }], "TASKS-1")).toBe(false);
  });
  it("uses the latest evidence and does not let normal comments reset it", () => {
    expect(hasReviewEvidence([user(evidence("TASKS-1", "PASS")), user("notes")], "TASKS-1")).toBe(true);
    expect(hasReviewEvidence([user(evidence("TASKS-1", "PASS")), user("**Evidence for `TASKS-1`** — PASS")], "TASKS-1")).toBe(false);
  });
});
