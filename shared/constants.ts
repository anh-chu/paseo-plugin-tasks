export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "on_hold",
  "in_review",
  "done",
  "canceled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = [
  "urgent",
  "high",
  "medium",
  "low",
  "none",
] as const;

export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_THREAD_LIVE_STATUSES = [
  "starting",
  "working",
  "idle",
  "completed",
  "failed",
] as const;

export type TaskThreadLiveStatus = (typeof TASK_THREAD_LIVE_STATUSES)[number];

export const PRESET_ENVIRONMENT_KINDS = [
  "project-default",
  "new-worktree",
] as const;

export type PresetEnvironmentKind = (typeof PRESET_ENVIRONMENT_KINDS)[number];

export const PRESET_PERMISSION_MODES = [
  "accept-edits",
  "auto",
  "full",
] as const;

export type PresetPermissionMode = (typeof PRESET_PERMISSION_MODES)[number];

export const TASK_SORTS = ["manual", "priority", "due"] as const;
export type TaskSort = (typeof TASK_SORTS)[number];

export const TASKS_PAGE_DEFAULT_LIMIT = 100;
export const TASKS_PAGE_MAX_LIMIT = 500;

export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
export const PROJECT_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{0,9}$/;
export const TASK_KEY_PATTERN = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d+)$/;
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;

export const STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  on_hold: "On Hold",
  in_review: "In Review",
  done: "Done",
  canceled: "Canceled",
};

export const PRIORITY_LABELS: Readonly<Record<TaskPriority, string>> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "No priority",
};

// Prefix of the project that holds suggestions from unlinked folders.
export const UNSORTED_PREFIX = "UNS";

export const PROJECT_COLORS = [
  "blue",
  "violet",
  "emerald",
  "orange",
  "rose",
  "amber",
  "cyan",
  "gray",
] as const;

export const COLOR_HEX: Readonly<Record<string, string>> = {
  blue: "#3b82f6",
  violet: "#8b5cf6",
  emerald: "#10b981",
  green: "#22c55e",
  orange: "#f97316",
  rose: "#f43f5e",
  red: "#ef4444",
  amber: "#f59e0b",
  yellow: "#eab308",
  cyan: "#06b6d4",
  gray: "#6b7280",
};

export function resolveColorHex(color: string): string {
  return COLOR_HEX[color.toLowerCase()] ?? (color.startsWith("#") ? color : "#3b82f6");
}

export function displayName(value: string): string {
  return value
    .split("_")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

export const TASK_CARD_KIND = "tasks-card";
export const TASK_TEXT_KIND = "tasks-text";
export const TASKS_SKILL_MARKER = "[paseo-plugin-tasks]";

export function buildTasksInstructions(requireEvidence = false): string {
  return `${TASKS_SKILL_MARKER}
# Paseo Tasks Integration
The user tracks work on a Paseo Tasks board. Keep it current without being asked, using the \`paseo-tasks\` CLI on your PATH (also \`bb-tasks\`) or the \`tasks\` MCP tools.

At the start of real work (code changes, investigations, anything over a few steps; not quick questions):
1. Run \`paseo-tasks context\` / MCP \`tasks_context\`. It shows this folder's project, the tasks this session is attached to, and open tasks to pick from.
2. Already attached to a task: work on it.
3. An open task matches the work: \`paseo-tasks attach ABC-12\` / MCP \`tasks_attach\`, then set it in_progress.
4. Nothing matches, or the folder has no project yet: suggest one with \`paseo-tasks propose --title "..." [--description "..."]\` / MCP \`tasks_propose_idea\`. The user approves it later from the pill beside the composer, so do not add a ::task line for it; do not wait, and do not suggest it again. Do not create tasks unless the user asks.

Keep the task you are attached to current, including one you just suggested and the user has not approved yet.
While working, comment at milestones (findings, decisions, blockers): \`paseo-tasks comment ABC-12 --body "..."\` / MCP \`tasks_comment\`.
When the work is done, comment what changed and how you checked it, then set the task in_review.${requireEvidence ? `
Before in_review or done, comment **Evidence for \`ABC-12\`** — VERDICT, followed by nonempty **What ran** and **What was not covered** sections. VERDICT is PASS, PASS WITH GAPS, FAILED CHECK, NOTHING CHECKABLE, or BLOCKED. Describe failures and gaps for review. Done requires PASS, PASS WITH GAPS, or NOTHING CHECKABLE.` : ""}
Skip all of this for quick questions and when the user asks you not to track the work. If a step fails, keep working on the user's request.

Other commands:
- Inspect or list: \`paseo-tasks show ABC-12\`, \`paseo-tasks list [--project ABC] [--status in_progress]\` / MCP \`tasks_show\`, \`tasks_list\`
- Update fields: \`paseo-tasks update ABC-12 --status in_review\` / MCP \`tasks_update\`. Change a task's stage only when your own instructions tell you to.
- A follow-up found while on a task (a bug, a next step): \`paseo-tasks propose ABC-12 --title "..."\`
- Files: \`paseo-tasks attachment add ABC-12 --file ./out.md\` and \`paseo-tasks attachment get <id> --out ./file\`
- Detach this session: \`paseo-tasks detach ABC-12\`
- When referring to a task in your reply, emit \`::task{key="ABC-12"}\` on its own line to render a live task card.`;
}

/** Quote a value as one literal POSIX shell argument. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function attachmentGetCommand(id: string, fileName: string): string {
  return `paseo-tasks attachment get ${id} --out ${shellQuote(`./${fileName}`)}`;
}
