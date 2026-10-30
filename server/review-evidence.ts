type EvidenceComment = { kind: string; body: string };
type Verdict = "PASS" | "PASS WITH GAPS" | "FAILED CHECK" | "NOTHING CHECKABLE" | "BLOCKED";

// Comments are ordered by creation. A return to an active state begins a new
// submission, so evidence from an earlier review cannot be reused.
export function reviewEvidenceVerdict(comments: readonly EvidenceComment[], key: string): Verdict | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i]!;
    if (comment.kind === "system" && (/^Status changed to (?:Backlog|Todo|In Progress|Canceled)\b/i.test(comment.body) || /^Dispatched to\b/i.test(comment.body))) return null;
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const heading = new RegExp("^\\*\\*Evidence for `" + escaped + "`\\*\\*", "m");
    if (!heading.test(comment.body)) continue;
    const validHeading = new RegExp("^\\*\\*Evidence for `" + escaped + "`\\*\\* — (PASS WITH GAPS|PASS|FAILED CHECK|NOTHING CHECKABLE|BLOCKED)[ \\t]*$", "m");
    const match = comment.body.match(validHeading);
    if (!match) return null;
    const sections = comment.body.slice(match.index! + match[0].length).match(/^\*\*What ran\*\*[ \t]*\n([\s\S]*?)^\*\*What was not covered\*\*[ \t]*\n([\s\S]+)$/m);
    return sections?.[1]?.trim() && sections?.[2]?.trim() ? match[1] as Verdict : null;
  }
  return null;
}

export function reviewEvidenceInstructions(key: string): string {
  return `Add a new comment for ${key} after the latest return to an active state, with each heading on its own line, then retry:\n\n` +
    `**Evidence for \`${key}\`** — PASS WITH GAPS\n\n` +
    `**What ran**\nDescribe checks and results, or explain why none ran.\n\n` +
    `**What was not covered**\nDescribe gaps or blockers, or say none.\n\n` +
    `Choose one verdict: PASS, PASS WITH GAPS, FAILED CHECK, NOTHING CHECKABLE, or BLOCKED. Done requires PASS, PASS WITH GAPS, or NOTHING CHECKABLE. A person can also change the status in the app.`;
}
