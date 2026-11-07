import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiStore, createDomainHandlers, STOPPED_AFTER_MS, stoppedSince, sweepStoppedTasks } from "../server/domain";
import { openTasksDatabase } from "../server/sqlite";

const now = Date.parse("2026-11-07T12:00:00.000Z");
const ago = (ms: number) => new Date(now - ms).toISOString();
const thread = (updatedAt: string) => ({ threadId: "mgr", updatedAt });
const agent = (status: string, updatedAt: string, pendingPermissions: unknown[] = []) => ({ status, updatedAt, pendingPermissions });

describe("stoppedSince", () => {
  it("is stopped when every agent is idle and nothing moved for the limit", () => {
    const live = new Map([["mgr", agent("idle", ago(STOPPED_AFTER_MS + 1))]]);
    expect(stoppedSince([thread(ago(STOPPED_AFTER_MS + 5))], [], live, now)).toBe(ago(STOPPED_AFTER_MS + 1));
  });

  it("is moving while a step agent started by the manager is running", () => {
    const live = new Map([
      ["mgr", agent("idle", ago(STOPPED_AFTER_MS * 3))],
      ["step", agent("running", ago(STOPPED_AFTER_MS * 2))],
    ]);
    expect(stoppedSince([thread(ago(STOPPED_AFTER_MS * 3))], ["step"], live, now)).toBeNull();
  });

  it("leaves an agent asking the user to Waiting, not Stopped", () => {
    const live = new Map([["mgr", agent("running", ago(STOPPED_AFTER_MS * 3), [{ id: "q" }])]]);
    expect(stoppedSince([thread(ago(STOPPED_AFTER_MS * 3))], [], live, now)).toBeNull();
    const idleAsking = new Map([["mgr", agent("idle", ago(STOPPED_AFTER_MS * 3), [{ id: "q" }])]]);
    expect(stoppedSince([thread(ago(STOPPED_AFTER_MS * 3))], [], idleAsking, now)).toBeNull();
  });

  it("is moving within the limit, and stopped when the agent is gone", () => {
    const fresh = new Map([["mgr", agent("idle", ago(60_000))]]);
    expect(stoppedSince([thread(ago(60_000))], [], fresh, now)).toBeNull();
    expect(stoppedSince([thread(ago(STOPPED_AFTER_MS * 2))], [], new Map(), now)).toBe(ago(STOPPED_AFTER_MS * 2));
  });
});

describe("stopped tasks and On Hold", () => {
  let tempDir: string;
  let store: ReturnType<typeof createApiStore>;
  let domain: ReturnType<typeof createDomainHandlers>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "paseo-tasks-stopped-"));
    store = createApiStore(openTasksDatabase(join(tempDir, "tasks.db")), tempDir);
    domain = createDomainHandlers(store, () => null);
  });
  afterEach(async () => {
    store.db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  function taskWithAgent(status: "in_progress" | "on_hold") {
    const project = domain.createProject({ name: "Stop", prefix: "STP", color: "blue" }).project;
    const created = domain.createTask({ projectId: project.id, title: "Run", status, priority: "none" });
    if (!created.ok) throw new Error("task creation failed");
    store.tasks.upsertTaskThread({ taskId: created.task.id, threadId: "mgr", presetName: "Run a playbook", title: "Manager", liveStatus: "idle" });
    store.db.prepare("UPDATE task_threads SET updated_at = ?").run(ago(STOPPED_AFTER_MS * 2));
    return created.task;
  }

  const paseo = (status: string) => ({
    agents: { list: async () => ({ entries: [{ agent: { id: "mgr", ...agent(status, ago(STOPPED_AFTER_MS * 2)) } }] }) },
  });

  it("puts a stopped task in Needs you and clears it when work resumes", async () => {
    const task = taskWithAgent("in_progress");
    await sweepStoppedTasks(store, paseo("idle") as never, now);
    expect(store.tasks.getTask(task.id)?.attention).toBe("stopped");
    expect(store.tasks.listTasks({ needsYou: true } as never).map((t) => t.id)).toContain(task.id);
    await sweepStoppedTasks(store, paseo("running") as never, now);
    expect(store.tasks.getTask(task.id)?.attention).toBeNull();
  });

  it("never flags a task On Hold, and accepts on_hold as a status", async () => {
    const task = taskWithAgent("on_hold");
    expect(store.tasks.getTask(task.id)?.status).toBe("on_hold");
    await sweepStoppedTasks(store, paseo("idle") as never, now);
    expect(store.tasks.getTask(task.id)?.attention).toBeNull();
  });

  it("clears Stopped when the status changes", async () => {
    const task = taskWithAgent("in_progress");
    await sweepStoppedTasks(store, paseo("idle") as never, now);
    store.tasks.updateTask(task.id, { status: "on_hold" });
    store.tasks.updateTask(task.id, { status: "in_progress" });
    expect(store.tasks.getTask(task.id)?.attention).toBeNull();
  });
});
