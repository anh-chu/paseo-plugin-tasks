import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findPlaybookStage, readPlaybookRuns, stageOfRun } from "../server/playbook-runs";

const run = (over: Record<string, unknown> = {}) => ({
  version: 1,
  id: "run_1",
  status: "waiting_gate",
  managerAgentId: "mgr",
  workspaceId: "wks_1",
  inputs: { request: "Spec bulk edit" },
  archivedAt: null,
  updatedAt: "2026-11-08T08:00:00.000Z",
  playbook: {
    id: "spec",
    title: "PM spec",
    steps: [
      { id: "investigate", kind: "agent" },
      { id: "confirm_scope", kind: "gate", title: "Confirm scope" },
      { id: "write_spec", kind: "agent" },
      { id: "retro", kind: "agent", afterTask: "retro" },
    ],
  },
  steps: { investigate: { status: "completed" }, confirm_scope: { status: "waiting" }, write_spec: { status: "pending" } },
  ...over,
});

describe("Playbooks stage on a task", () => {
  it("names the current step, counts main-graph steps, and flags an open gate", () => {
    expect(stageOfRun(run() as never)).toEqual({
      runId: "run_1", playbookTitle: "PM spec", status: "waiting_gate",
      step: "Confirm scope", waiting: true, done: 1, total: 3, workspaceId: "wks_1",
    });
    const working = stageOfRun(run({ steps: { investigate: { status: "completed" }, confirm_scope: { status: "completed" }, write_spec: { status: "running" } } }) as never);
    expect(working).toMatchObject({ step: "Write spec", waiting: false, done: 2 });
  });

  it("finds a run by its attached manager or by the task key in its inputs, active first", () => {
    const old = run({ id: "run_old", status: "completed", updatedAt: "2026-11-09T00:00:00.000Z" });
    const byKey = run({ id: "run_key", managerAgentId: "other", inputs: { task: "PM-3" } });
    expect(findPlaybookStage([old as never, run() as never], { key: "PM-1", threadIds: ["mgr"] })?.runId).toBe("run_1");
    expect(findPlaybookStage([byKey as never], { key: "PM-3", threadIds: [] })?.runId).toBe("run_key");
    expect(findPlaybookStage([run({ archivedAt: "2026-11-08" }) as never], { key: "PM-1", threadIds: ["mgr"] })).toBeNull();
    expect(findPlaybookStage([run() as never], { key: "PM-9", threadIds: ["someone"] })).toBeNull();
  });

  it("reads nothing when Playbooks is not installed, and skips files it does not understand", async () => {
    expect(readPlaybookRuns("/nonexistent/paseo-playbooks/runs")).toEqual([]);
    const dir = await mkdtemp(join(tmpdir(), "runs-"));
    await writeFile(join(dir, "a.json"), JSON.stringify(run()));
    await writeFile(join(dir, "b.json"), JSON.stringify(run({ version: 2 })));
    await writeFile(join(dir, "c.json"), "not json");
    expect(readPlaybookRuns(dir).map((r) => r.id)).toEqual(["run_1"]);
    await rm(dir, { recursive: true, force: true });
  });
});
