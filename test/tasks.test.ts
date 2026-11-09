import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transformAssistantTaskDirectives } from "../shared/directive";
import { buildTasksInstructions } from "../shared/constants";
import { startTasksBridge } from "../server/bridge";
import { runTasksCli } from "../server/cli-runner";
import {
  createApiStore,
  createDomainHandlers,
  reconcileOnFirstCapture,
  registerLifecycleHooks,
  transitionTrackedThread,
  type TasksApiStore,
  type TasksDomain,
} from "../server/domain";
import { openTasksDatabase } from "../server/sqlite";
import { TasksPageCursorError } from "../server/store";

describe("paseo-plugin-tasks", () => {
  let tempDir: string;
  let store: TasksApiStore;
  let domain: TasksDomain;
  const sentPrompts: Array<{ agentId: string; text: string }> = [];
  const createdWorkspaces: Array<{ title?: string; source: unknown }> = [];
  const createdAgents: Array<{
    title?: string;
    prompt?: string;
    labels?: Record<string, string>;
    config: unknown;
  }> = [];

  const mockPaseo = {
    projects: {
      list: vi.fn(async () => ({
        requestId: "req_1",
        projects: [
          {
            projectId: "prj_demo123",
            projectDisplayName: "Demo Repo",
            projectRootPath: "/tmp/demo-repo",
            projectKind: "git" as const,
          },
        ],
      })),
    },
    workspaces: {
      create: vi.fn(async (opts: { title?: string; source: unknown }) => {
        createdWorkspaces.push(opts);
        return {
          id: "wks_spawned_1",
          projectId: "prj_demo123",
          directory: "/tmp/demo-repo-wt",
          name: "wt-1",
          status: "running" as const,
          agents: {
            create: vi.fn(async (agentOpts: {
              title?: string;
              prompt?: string;
              labels?: Record<string, string>;
              config: unknown;
            }) => {
              createdAgents.push(agentOpts);
              return {
                id: "agent-uuid-1001",
                timeline: {
                  append: vi.fn(async () => ({ seq: 1, epoch: "e1" })),
                },
              };
            }),
          },
        };
      }),
    },
    agents: {
      list: vi.fn(async () => ({
        requestId: "req_agents",
        entries: [
          {
            agent: {
              id: "agent-uuid-1001",
              workspaceId: "wks_spawned_1",
              provider: "codex",
              status: "running",
              title: "PROD-1 · Ship task delegation",
              cwd: "/tmp/demo-repo-wt",
              archivedAt: null,
            },
          },
        ],
        pageInfo: { hasMore: false, nextCursor: null },
      })),
      ref: vi.fn((agentId: string) => ({
        id: agentId,
        refresh: vi.fn(async () => ({
          agent: {
            id: agentId,
            workspaceId: "wks_spawned_1",
            provider: "codex",
            status: "idle",
            title: "Worker Agent",
            cwd: "/tmp/demo-repo-wt",
            archivedAt: null,
          },
          project: null,
        })),
        send: vi.fn(async (text: string) => {
          sentPrompts.push({ agentId, text });
        }),
        timeline: {
          append: vi.fn(async () => ({ seq: 1, epoch: "e1" })),
        },
      })),
    },
    providers: {
      listAvailable: vi.fn(async () => ({
        requestId: "req_prov",
        providers: [{ provider: "codex", available: true, error: null }],
      })),
      listModels: vi.fn(async () => ({
        requestId: "req_models",
        models: [{ provider: "codex", id: "gpt-5.4", label: "GPT-5.4" }],
      })),
    },
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "paseo-tasks-test-"));
    const db = openTasksDatabase(join(tempDir, "tasks.db"));
    store = createApiStore(db, tempDir);
    store.ensureDefaultPresets();
    domain = createDomainHandlers(store, () => mockPaseo as never, undefined, async () => true);
    sentPrompts.length = 0;
    createdWorkspaces.length = 0;
    createdAgents.length = 0;
  });

  afterEach(async () => {
    store.db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("rejects invalid preset permissions without corrupting the database and recovers old rows", async () => {
    const preset = domain.listPresets().presets[0]!;
    const result = await runTasksCli(["preset", "update", preset.id, "--permission", "default"], store, domain);
    expect(result.exitCode).not.toBe(0);
    expect(domain.listPresets().presets.find((p) => p.id === preset.id)?.permissionMode).toBe(preset.permissionMode);
    expect(() => store.tasks.updatePreset(preset.id, { permissionMode: "default" as never })).toThrow();
    store.db.prepare("UPDATE presets SET permission_mode = ? WHERE id = ?").run("default", preset.id);
    expect(domain.listPresets().presets.find((p) => p.id === preset.id)?.permissionMode).toBe("accept-edits");
    store.ensureDefaultPresets();
  });

  it("does not require or ask for evidence when the setting is off", async () => {
    const off = createDomainHandlers(store, () => mockPaseo as never);
    const project = off.createProject({ name: "Off", prefix: "OFF", color: "blue", linkedBbProjectId: "prj_demo123" }).project;
    const created = off.createTask({ projectId: project.id, title: "Check", status: "in_progress", priority: "medium" });
    if (!created.ok) throw new Error("task creation failed");
    const moved = await runTasksCli(["update", created.task.key, "--status", "in_review"], store, off);
    expect(moved.exitCode).toBe(0);
    await off.delegate({ taskId: created.task.id, presetId: off.listPresets().presets[0]!.id });
    expect(createdAgents.at(-1)?.prompt ?? "").not.toContain("Evidence for");
    expect(buildTasksInstructions(false)).not.toContain("Evidence for");
    expect(buildTasksInstructions(true)).toContain("Evidence for");
  });

  it("requires fresh evidence for CLI review and completion while allowing failed checks for review", async () => {
    const project = domain.createProject({ name: "Review", prefix: "REV", color: "blue" }).project;
    const created = domain.createTask({ projectId: project.id, title: "Check", status: "in_progress", priority: "medium" });
    if (!created.ok) throw new Error("task creation failed");
    const task = created.task;
    const attempt = (status: string) => runTasksCli(["update", task.key, "--status", status, "--json"], store, domain);
    expect((await attempt("in_review")).exitCode).not.toBe(0);
    expect((await attempt("done")).exitCode).not.toBe(0);
    await domain.createComment({ taskId: task.id, body: "**Evidence for `REV-1`** — FAILED CHECK\n\n**What ran**\nA test failed.\n\n**What was not covered**\nThe integration test.", notify: false });
    expect((await attempt("in_review")).exitCode).toBe(0);
    expect((await attempt("done")).exitCode).not.toBe(0);
    await domain.createComment({ taskId: task.id, body: "**Evidence for `REV-1`** — PASS\n\n**What ran**\nAll checks passed.\n\n**What was not covered**\nNothing identified.", notify: false });
    expect((await attempt("done")).exitCode).toBe(0);
    domain.updateTask({ taskId: task.id, status: "in_progress" });
    expect((await attempt("in_review")).exitCode).not.toBe(0);
    await domain.createComment({ taskId: task.id, body: "**Evidence for `REV-1`** — BLOCKED\n\n**What ran**\nNo checks could run.\n\n**What was not covered**\nWaiting for credentials.", notify: false });
    expect((await attempt("in_review")).exitCode).toBe(0);
    expect((await attempt("done")).exitCode).not.toBe(0);
    await domain.createComment({ taskId: task.id, body: "**Evidence for `REV-1`** — NOTHING CHECKABLE\n\n**What ran**\nNo automated checks apply.\n\n**What was not covered**\nNo tests apply to this task.", notify: false });
    expect((await attempt("done")).exitCode).toBe(0);
  });

  it("lists only live, unadopted sessions in the linked Paseo project", async () => {
    const project = domain.createProject({ name: "Inbox", prefix: "INB", color: "blue", linkedBbProjectId: "prj_demo123" }).project;
    const unlinked = domain.createProject({ name: "Loose", prefix: "LSE", color: "blue" }).project;
    const agent = (id: string, workspaceId: string, extra: Record<string, unknown> = {}) => ({
      agent: { id, workspaceId, provider: "claude", status: "idle", title: id, updatedAt: "2026-11-01T00:00:00Z", archivedAt: null, ...extra },
      project: { projectKey: workspaceId === "wks_in" ? "prj_demo123" : "prj_other" },
    });
    const paseo = {
      agents: {
        list: vi.fn(async () => ({
          entries: [
            agent("free", "wks_in", { updatedAt: "2026-11-02T00:00:00Z" }),
            agent("older", "wks_in"),
            agent("adopted", "wks_in"),
            agent("archived", "wks_in", { archivedAt: "2026-11-01T00:00:00Z" }),
            agent("elsewhere", "wks_out"),
          ],
        })),
        ref: mockPaseo.agents.ref,
      },
    };
    const task = domain.createTask({ projectId: project.id, title: "Taken", status: "todo", priority: "none" });
    if (!task.ok) throw new Error("task creation failed");
    await domain.taskThreadsAttach({ taskId: task.task.id, threadId: "adopted" }, paseo as never);

    const { threads } = await domain.listUnattachedThreads({ projectId: project.id }, paseo as never);
    expect(threads.map((t) => t.id)).toEqual(["free", "older"]);
    expect(await domain.listUnattachedThreads({ projectId: unlinked.id }, paseo as never)).toEqual({ threads: [] });
  });

  it("sends command-code a supported mode and rejects unknown full-access modes before creating a workspace", async () => {
    const project = domain.createProject({ name: "Demo", prefix: "DEMO", color: "blue", linkedBbProjectId: "prj_demo123" }).project;
    const task = domain.createTask({ projectId: project.id, title: "Example", status: "todo", priority: "medium" });
    if (!task.ok) throw new Error("task creation failed");
    const preset = domain.listPresets().presets[0]!;
    domain.updatePreset({ presetId: preset.id, providerId: "command-code", modelId: "demo", permissionMode: "full" });
    await domain.delegate({ taskId: task.task.id, presetId: preset.id });
    expect(createdAgents[0]?.config).toMatchObject({ modeId: "bypass" });
    domain.updatePreset({ presetId: preset.id, providerId: "unknown-provider" });
    await expect(domain.delegate({ taskId: task.task.id, presetId: preset.id })).rejects.toThrow("Full permission mode is not supported");
    expect(createdWorkspaces).toHaveLength(1);
  });

  it("connects the CLI and MCP bridge on their first delegation without a prior RPC", async () => {
    const project = domain.createProject({ name: "Bridge", prefix: "BRG", color: "blue", linkedBbProjectId: "prj_demo123" }).project;
    const task = domain.createTask({ projectId: project.id, title: "Delegate", status: "todo", priority: "medium" });
    if (!task.ok) throw new Error("task creation failed");
    const preset = domain.listPresets().presets[0]!;
    let connected = false;
    const bridgeDomain = createDomainHandlers(store, () => connected ? mockPaseo as never : null);
    const ensure = vi.fn(async () => { connected = true; });
    const bridge = await startTasksBridge(store, bridgeDomain, ensure);
    const headers = { "content-type": "application/json", authorization: `Bearer ${bridge.token}` };
    try {
      const cli = await fetch(`${bridge.url}/cli`, {
        method: "POST", headers,
        body: JSON.stringify({ argv: ["delegate", task.task.key, "--preset", preset.id, "--json"] }),
      }).then((response) => response.json());
      expect(cli.exitCode).toBe(0);
      expect(ensure).toHaveBeenCalledTimes(1);
      connected = false;
      const mcp = await fetch(`${bridge.url}/mcp`, {
        method: "POST", headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tasks_delegate", arguments: { key: task.task.key, preset: preset.id } } }),
      }).then((response) => response.json());
      expect(mcp.result.isError).toBe(false);
      expect(ensure).toHaveBeenCalledTimes(2);
    } finally {
      await bridge.close();
    }
  });

  it("returns a failure when a bridge connection cannot be established", async () => {
    const bridge = await startTasksBridge(store, domain, async () => { throw new Error("daemon unavailable"); });
    const headers = { "content-type": "application/json", authorization: `Bearer ${bridge.token}` };
    try {
      const cli = await fetch(`${bridge.url}/cli`, { method: "POST", headers, body: JSON.stringify({ argv: ["delegate", "BRG-1"] }) }).then((r) => r.json());
      expect(cli.exitCode).toBe(1);
      expect(cli.stderr).toContain("daemon unavailable");
      const mcp = await fetch(`${bridge.url}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tasks_delegate", arguments: {} } }) }).then((r) => r.json());
      expect(mcp.result.isError).toBe(true);
      expect(mcp.result.content[0].text).toContain("daemon unavailable");
    } finally { await bridge.close(); }
  });

  it("creates folders, projects, labels, tasks, subtasks, moves across projects with key aliases, and enforces cursor revisions", () => {
    const folder = domain.createFolder({ name: "Engineering" }).folder;
    const prod = domain.createProject({
      name: "Product",
      prefix: "PROD",
      color: "blue",
      folderId: folder.id,
      linkedBbProjectId: "prj_demo123",
    }).project;
    const ops = domain.createProject({
      name: "Ops",
      prefix: "OPS",
      color: "orange",
    }).project;

    const label = domain.createLabel({
      projectId: prod.id,
      name: "Backend",
      color: "blue",
    }).label;

    const t1Res = domain.createTask({
      projectId: prod.id,
      title: "Ship task delegation",
      description: "Implement worktree delegation.",
      priority: "urgent",
      status: "todo",
      dueDate: "2026-10-30",
      labelIds: [label.id],
    });
    expect(t1Res.ok).toBe(true);
    if (!t1Res.ok) return;
    expect(t1Res.task.key).toBe("PROD-1");

    const subRes = domain.createTask({
      projectId: prod.id,
      title: "Add unit tests",
      parentTaskId: t1Res.task.id,
    });
    expect(subRes.ok).toBe(true);
    if (!subRes.ok) return;
    expect(subRes.task.key).toBe("PROD-2");

    // Cursor pagination check
    const page1 = domain.listTasks({ projectId: prod.id, limit: 1 });
    expect(page1.tasks).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();

    // Mutating task list invalidates old cursor
    domain.updateTask({
      taskId: t1Res.task.id,
      priority: "high",
    });
    expect(() =>
      domain.listTasks({
        projectId: prod.id,
        limit: 1,
        cursor: page1.nextCursor!,
      }),
    ).toThrow(TasksPageCursorError);

    // Move task + subtask to OPS and verify old PROD-1 alias still resolves
    const moved = domain.moveTaskToProject({
      taskId: t1Res.task.id,
      projectId: ops.id,
    });
    expect(moved.ok).toBe(true);
    expect(moved.task.key).toBe("OPS-1");
    expect(domain.getTaskByKey({ taskKey: "PROD-1" }).task?.id).toBe(
      t1Res.task.id,
    );
    expect(domain.getTaskByKey({ taskKey: "OPS-1" }).task?.id).toBe(
      t1Res.task.id,
    );
  });

  it("starts a task that enters Todo when its project has an auto-start preset, and only then", async () => {
    const preset = domain.listPresets().presets[0]!;
    const project = domain.createProject({ name: "Auto", prefix: "AUTO", color: "blue", linkedBbProjectId: "prj_demo123" }).project;
    const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

    const before = createdAgents.length;
    const quiet = domain.createTask({ projectId: project.id, title: "Not yet", status: "todo", priority: "none" });
    await flush();
    expect(createdAgents.length).toBe(before);

    store.tasks.updateProject(project.id, { autoStartPresetId: preset.id });
    const backlog = domain.createTask({ projectId: project.id, title: "Later", status: "backlog", priority: "none" });
    await flush();
    expect(createdAgents.length).toBe(before);

    if (!backlog.ok || !quiet.ok) throw new Error("task creation failed");
    domain.boardMove({ taskId: backlog.task.id, status: "todo" });
    await flush();
    expect(createdAgents.length).toBe(before + 1);
    expect(store.tasks.getTask(backlog.task.id)?.status).toBe("in_progress");

    // Moving within Todo, or into Todo with an agent already working, starts nothing.
    store.tasks.upsertTaskThread({ taskId: quiet.task.id, threadId: "agent-busy", presetName: "Manual", title: "Busy", liveStatus: "working" });
    domain.updateTask({ taskId: quiet.task.id, status: "backlog" });
    domain.updateTask({ taskId: quiet.task.id, status: "todo" });
    await flush();
    expect(createdAgents.length).toBe(before + 1);
  });

  it("tells a delegated agent about sessions already attached to the task", async () => {
    const prod = domain.createProject({
      name: "Product",
      prefix: "PROD",
      color: "blue",
      linkedBbProjectId: "prj_demo123",
    }).project;
    const taskRes = domain.createTask({
      projectId: prod.id,
      title: "Ship analytics",
      description: "",
      status: "todo",
      priority: "high",
    });
    if (!taskRes.ok) throw new Error("task not created");
    store.tasks.upsertTaskThread({
      taskId: taskRes.task.id,
      threadId: "agent-earlier-1",
      workspaceId: null,
      presetName: "Manual",
      title: "Earlier research session",
      liveStatus: "idle",
    });

    await domain.delegate({
      taskId: taskRes.task.id,
      presetId: domain.listPresets().presets[0]!.id,
    });

    const prompt = createdAgents[0]?.prompt ?? "";
    expect(prompt).toContain("## Attached agent sessions");
    expect(prompt).toContain("agent-earlier-1 · Earlier research session (idle)");
  });

  it("names an agent comment by the preset of the session that wrote it", async () => {
    const prod = domain.createProject({
      name: "Product",
      prefix: "PROD",
      color: "blue",
      linkedBbProjectId: "prj_demo123",
    }).project;
    const taskRes = domain.createTask({
      projectId: prod.id,
      title: "Ship analytics",
      description: "",
      status: "todo",
      priority: "high",
    });
    if (!taskRes.ok) throw new Error("task not created");
    store.tasks.upsertTaskThread({
      taskId: taskRes.task.id,
      threadId: "agent-lead-1",
      workspaceId: null,
      presetName: "Feature lead",
      title: "PROD-1 · Ship analytics",
      liveStatus: "idle",
    });
    await domain.createComment({
      taskId: taskRes.task.id,
      kind: "agent",
      authorName: "agent (agent-lead-1)",
      threadId: "agent-lead-1",
      body: "Scope proposal ready.",
    });

    const { comments } = await domain.listComments({ taskId: taskRes.task.id }, null);
    expect(comments.find((c) => c.kind === "agent")?.presetName).toBe("Feature lead");
  });

  it("delegates a task to a Paseo worktree agent, tracks lifecycle transitions, and steers the agent on comment --notify", async () => {
    const prod = domain.createProject({
      name: "Product",
      prefix: "PROD",
      color: "blue",
      linkedBbProjectId: "prj_demo123",
    }).project;
    const taskRes = domain.createTask({
      projectId: prod.id,
      title: "Implement auth middleware",
      description: "Verify JWT claims.",
      status: "todo",
      priority: "high",
    });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;

    const presets = domain.listPresets().presets;
    expect(presets.length).toBeGreaterThan(0);
    const worktreePreset = presets.find(
      (p) => p.environmentKind === "new-worktree",
    )!;

    const delegated = await domain.delegate({
      taskId: taskRes.task.id,
      presetId: worktreePreset.id,
      extraInstructions: "Focus on token expiry edge cases.",
    });

    expect(delegated.threadId).toBe("agent-uuid-1001");
    expect(delegated.workspaceId).toBe("wks_spawned_1");
    expect(createdWorkspaces).toHaveLength(1);
    expect(createdAgents).toHaveLength(1);
    expect(createdAgents[0]?.labels).toMatchObject({
      taskKey: "PROD-1",
      taskId: taskRes.task.id,
    });

    // Task automatically advanced to in_progress
    const updatedTask = domain.getTaskByKey({ taskKey: "PROD-1" }).task!;
    expect(updatedTask.status).toBe("in_progress");

    // Agent posts a milestone comment
    await domain.createComment({
      taskId: updatedTask.id,
      kind: "agent",
      authorName: "agent (agent-uuid-1001)",
      threadId: "agent-uuid-1001",
      body: "Implemented middleware; running test suite.",
      notify: false,
      awaitDelivery: true,
    });

    // User posts a follow-up comment with notify: true -> steers agent-uuid-1001
    const userComment = await domain.createComment({
      taskId: updatedTask.id,
      kind: "user",
      authorName: "You",
      body: "Also support leeway of 30 seconds.",
      notify: true,
      awaitDelivery: true,
    });
    expect(userComment.comment.notifiedCount).toBe(1);
    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]?.agentId).toBe("agent-uuid-1001");
    expect(sentPrompts[0]?.text).toContain("Also support leeway of 30 seconds.");

    // Lifecycle transition to completed writes a system comment
    transitionTrackedThread(store, "agent-uuid-1001", "completed");
    const threads = domain.listTaskThreads({ taskId: updatedTask.id }).taskThreads;
    expect(threads[0]?.liveStatus).toBe("completed");
    const comments = (await domain.listComments({ taskId: updatedTask.id })).comments;
    expect(
      comments.some((c) => c.kind === "system" && c.body.includes("completed")),
    ).toBe(true);
  });

  it("supports CLI commands and the local HTTP + MCP bridge", async () => {
    const seedRes = await runTasksCli(["seed-demo", "--yes", "--json"], store, domain);
    expect(seedRes.exitCode).toBe(0);
    const seeded = JSON.parse(seedRes.stdout) as { tasksCreated: number };
    expect(seeded.tasksCreated).toBe(12);

    const showRes = await runTasksCli(["show", "TASKS-1", "--json"], store, domain);
    expect(showRes.exitCode).toBe(0);
    const shown = JSON.parse(showRes.stdout) as { task: { key: string; title: string } };
    expect(shown.task.key).toBe("TASKS-1");

    // Test HTTP & MCP bridge
    const bridge = await startTasksBridge(store, domain);
    try {
      const mcpList = await fetch(`${bridge.url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bridge.token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        }),
      }).then((r) => r.json());
      expect(mcpList.result.tools.length).toBeGreaterThanOrEqual(8);

      const mcpCall = await fetch(`${bridge.url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bridge.token}`,
          "x-paseo-agent-id": "agent-uuid-1001",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "tasks_update",
            arguments: {
              key: "TASKS-1",
              status: "in_review",
            },
          },
        }),
      }).then((r) => r.json());
      // A submission with no evidence is refused, and the card does not move: review must not
      // become a rubber stamp for a claim.
      expect(mcpCall.result.isError).toBe(true);
      expect(mcpCall.result.content[0].text).toContain("**Evidence for `TASKS-1`**");
      expect(domain.getTaskByKey({ taskKey: "TASKS-1" }).task?.status).not.toBe(
        "in_review",
      );
      const directDone = await fetch(`${bridge.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bridge.token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "tasks_update", arguments: { key: "TASKS-1", status: "done" } } }),
      }).then((r) => r.json());
      expect(directDone.result.isError).toBe(true);
      expect(domain.getTaskByKey({ taskKey: "TASKS-1" }).task?.status).not.toBe("done");

      // With an evidence block on the card, the same submission is accepted.
      const target = domain.getTaskByKey({ taskKey: "TASKS-1" }).task;
      expect(target).toBeDefined();
      await domain.createComment({
        taskId: target!.id,
        kind: "user",
        authorName: "gate",
        body: "**Evidence for `TASKS-1`** — PASS WITH GAPS\n\n**What ran**\n- tests → pass\n\n**What was not covered**\n- nothing identified",
        notify: false,
        awaitDelivery: false,
      });
      const resubmit = await fetch(`${bridge.url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bridge.token}`,
          "x-paseo-agent-id": "agent-uuid-1001",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "tasks_update",
            arguments: { key: "TASKS-1", status: "in_review" },
          },
        }),
      }).then((r) => r.json());
      expect(resubmit.result.isError).toBe(false);
      expect(domain.getTaskByKey({ taskKey: "TASKS-1" }).task?.status).toBe(
        "in_review",
      );
    } finally {
      await bridge.close();
    }
  });

  it("migrates an existing database without changing its projects or tasks, with stages off", () => {
    const project = domain.createProject({ name: "Legacy", prefix: "LEG", color: "blue" }).project;
    const created = domain.createTask({ projectId: project.id, title: "Old task", status: "todo", priority: "high" });
    if (!created.ok) throw new Error("task not created");
    const dbPath = join(tempDir, "tasks.db");
    store.db.exec(`
      ALTER TABLE tasks DROP COLUMN stage;
      ALTER TABLE projects DROP COLUMN stages;
      DELETE FROM schema_version WHERE version = 6;
    `);
    store.db.close();

    store = createApiStore(openTasksDatabase(dbPath), tempDir);
    domain = createDomainHandlers(store, () => mockPaseo as never);
    expect(domain.listProjects().projects).toEqual([{ ...project, nextTaskNumber: 2, stages: [] }]);
    expect(domain.getTask({ taskId: created.task.id }).task).toEqual({ ...created.task, stage: null });
    expect(domain.updateTask({ taskId: created.task.id, stage: "Build" })).toMatchObject({
      ok: false,
      error: { code: "stage_invalid" },
    });
  });

  it("validates project stages", () => {
    const project = domain.createProject({
      name: "Feature",
      prefix: "FEAT",
      color: "blue",
      stages: ["  Investigate ", "", "Spec", "Build"],
    }).project;
    expect(project.stages).toEqual(["Investigate", "Spec", "Build"]);
    expect(() => domain.updateProject({ projectId: project.id, stages: ["Spec", "spec"] })).toThrow(/duplicate/i);
    expect(() => domain.updateProject({ projectId: project.id, stages: ["x".repeat(41)] })).toThrow(/40/);
    expect(() =>
      domain.updateProject({ projectId: project.id, stages: Array.from({ length: 21 }, (_, i) => `S${i}`) }),
    ).toThrow(/20/);
    expect(() => domain.updateProject({ projectId: project.id, stages: ["None"] })).toThrow(/none/i);
    expect(domain.updateProject({ projectId: project.id, name: "Feature 2" }).project.stages).toEqual([
      "Investigate",
      "Spec",
      "Build",
    ]);
    expect(domain.updateProject({ projectId: project.id, stages: [] }).project.stages).toEqual([]);
  });

  it("sets, clears, and rejects task stages with a system comment for each change", async () => {
    const project = domain.createProject({ name: "Feature", prefix: "FEAT", color: "blue", stages: ["Spec", "Build"] }).project;
    const plain = domain.createProject({ name: "Plain", prefix: "PLN", color: "blue" }).project;
    const created = domain.createTask({ projectId: project.id, title: "Feature", status: "todo" });
    const plainTask = domain.createTask({ projectId: plain.id, title: "Plain", status: "todo" });
    if (!created.ok || !plainTask.ok) throw new Error("task not created");
    expect(created.task.stage).toBeNull();

    const set = domain.updateTask({ taskId: created.task.id, stage: "build" });
    expect(set).toMatchObject({ ok: true, task: { stage: "Build", status: "todo" } });
    expect(domain.updateTask({ taskId: created.task.id, stage: "Build" }).ok).toBe(true);
    expect(domain.updateTask({ taskId: created.task.id, stage: "Ship" })).toMatchObject({
      ok: false,
      error: { code: "stage_invalid", message: expect.stringContaining("Spec, Build") },
    });
    expect(domain.updateTask({ taskId: created.task.id, stage: null })).toMatchObject({ ok: true, task: { stage: null } });
    expect(domain.updateTask({ taskId: plainTask.task.id, stage: "Spec" })).toMatchObject({
      ok: false,
      error: { code: "stage_invalid" },
    });

    const { comments } = await domain.listComments({ taskId: created.task.id });
    expect(comments.filter((c) => c.kind === "system").map((c) => c.body)).toEqual([
      "Stage changed to Build by You",
      "Stage cleared by You",
    ]);
  });

  it("keeps a stage when moving to a project that has it and clears it otherwise", async () => {
    const a = domain.createProject({ name: "A", prefix: "AAA", color: "blue", stages: ["Spec", "Build"] }).project;
    const b = domain.createProject({ name: "B", prefix: "BBB", color: "blue", stages: ["build"] }).project;
    const c = domain.createProject({ name: "C", prefix: "CCC", color: "blue" }).project;
    const created = domain.createTask({ projectId: a.id, title: "Feature", status: "todo" });
    if (!created.ok) throw new Error("task not created");
    domain.updateTask({ taskId: created.task.id, stage: "Build" });

    expect(domain.moveTaskToProject({ taskId: created.task.id, projectId: b.id }).task.stage).toBe("build");
    expect(domain.moveTaskToProject({ taskId: created.task.id, projectId: c.id }).task.stage).toBeNull();
    const { comments } = await domain.listComments({ taskId: created.task.id });
    expect(comments.at(-1)?.body).toBe("Stage cleared by You");
  });

  it("sets project stages and task stages from the CLI", async () => {
    const created = await runTasksCli(
      ["project", "create", "--name", "Feature", "--prefix", "FEAT", "--stages", "Investigate, Spec,Build"],
      store,
      domain,
    );
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toBe("Created project FEAT  Feature");
    expect((await runTasksCli(["project", "show", "FEAT"], store, domain)).stdout).toMatch(
      /^Stages\s+Investigate, Spec, Build$/m,
    );
    await runTasksCli(["project", "create", "--name", "Plain", "--prefix", "PLN"], store, domain);
    expect((await runTasksCli(["project", "show", "PLN"], store, domain)).stdout).not.toMatch(/^Stages/m);

    await runTasksCli(["create", "--project", "FEAT", "--title", "Ship it"], store, domain);
    expect((await runTasksCli(["show", "FEAT-1"], store, domain)).stdout).not.toMatch(/^Stage\s/m);
    const update = await runTasksCli(["update", "FEAT-1", "--stage", "spec"], store, domain);
    expect(update).toMatchObject({ exitCode: 0, stdout: "Updated FEAT-1  Ship it" });
    expect((await runTasksCli(["show", "FEAT-1"], store, domain)).stdout).toMatch(/^Stage\s+Spec$/m);
    const invalid = await runTasksCli(["update", "FEAT-1", "--stage", "Ship"], store, domain);
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr).toContain("Ship");
    await runTasksCli(["update", "FEAT-1", "--stage", "none"], store, domain);
    expect((await runTasksCli(["show", "FEAT-1"], store, domain)).stdout).not.toMatch(/^Stage\s/m);

    expect((await runTasksCli(["project", "update", "FEAT", "--stages", ""], store, domain)).exitCode).toBe(0);
    expect(domain.listProjects().projects.find((p) => p.prefix === "FEAT")?.stages).toEqual([]);
    expect((await runTasksCli(["--help"], store, domain)).stdout).toContain("--stage");
  });

  it("sets and clears a stage through MCP tasks_update", async () => {
    const project = domain.createProject({ name: "Feature", prefix: "FEAT", color: "blue", stages: ["Spec", "Build"] }).project;
    domain.createTask({ projectId: project.id, title: "Ship it", status: "todo" });
    const bridge = await startTasksBridge(store, domain);
    const call = (name: string, args: Record<string, unknown>) =>
      fetch(`${bridge.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bridge.token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }).then((r) => r.json());
    try {
      const tools = await fetch(`${bridge.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bridge.token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }).then((r) => r.json());
      const update = tools.result.tools.find((t: { name: string }) => t.name === "tasks_update");
      expect(update.inputSchema.properties.stage).toBeDefined();

      expect((await call("tasks_update", { key: "FEAT-1", stage: "build" })).result.isError).toBe(false);
      expect(domain.getTaskByKey({ taskKey: "FEAT-1" }).task?.stage).toBe("Build");
      expect((await call("tasks_update", { key: "FEAT-1", stage: "Ship" })).result.isError).toBe(true);
      expect((await call("tasks_update", { key: "FEAT-1", stage: null })).result.isError).toBe(false);
      expect(domain.getTaskByKey({ taskKey: "FEAT-1" }).task?.stage).toBeNull();
      await call("tasks_update", { key: "FEAT-1", stage: "Spec" });
      expect((await call("tasks_update", { key: "FEAT-1", stage: "none" })).result.isError).toBe(false);
      expect(domain.getTaskByKey({ taskKey: "FEAT-1" }).task?.stage).toBeNull();

      const projects = JSON.parse((await call("tasks_projects", {})).result.content[0].text);
      expect(projects.projects[0].stages).toEqual(["Spec", "Build"]);
    } finally {
      await bridge.close();
    }
  });

  describe("feature lead support", () => {
    type Handler = (event: unknown, context: unknown) => unknown;
    const hooks = new Map<string, Handler>();
    const fire = (name: string, event: unknown) =>
      hooks.get(name)!(event, { paseo: mockPaseo, signal: new AbortController().signal });
    const agentRef = (id: string) => ({ id, workspaceId: null, parentAgentId: null, provider: "codex", cwd: "/tmp", title: null });

    function setupLeadAndWorker() {
      const project = domain.createProject({ name: "Feature", prefix: "FEAT", color: "blue", linkedBbProjectId: "prj_demo123" }).project;
      const parent = domain.createTask({ projectId: project.id, title: "Lead the feature", status: "in_progress" });
      if (!parent.ok) throw new Error("parent not created");
      const sub = domain.createTask({ projectId: project.id, title: "Build the API", status: "in_progress", parentTaskId: parent.task.id });
      if (!sub.ok) throw new Error("subtask not created");
      store.tasks.upsertTaskThread({ taskId: parent.task.id, threadId: "agent-lead", workspaceId: null, presetName: "Feature lead", title: "Lead", liveStatus: "idle" });
      store.tasks.upsertTaskThread({ taskId: sub.task.id, threadId: "agent-worker", workspaceId: null, presetName: "Backend worker", title: "Worker", liveStatus: "idle" });
      return { parent: parent.task, sub: sub.task };
    }

    async function systemBodies(taskId: string) {
      return (await domain.listComments({ taskId }, null)).comments.filter((c) => c.kind === "system").map((c) => c.body);
    }

    beforeEach(() => {
      hooks.clear();
      registerLifecycleHooks({ on: (name: string, handler: Handler) => hooks.set(name, handler) } as never, store, () => {}, async () => reportingOn);
    });
    let reportingOn = true;
    afterEach(() => {
      reportingOn = true;
    });

    it("reports nothing when the setting is off", async () => {
      reportingOn = false;
      const { parent, sub } = setupLeadAndWorker();
      await fire("agent.turn_started", { agent: agentRef("agent-worker"), turnId: "t" });
      await fire("agent.turn_ended", { agent: agentRef("agent-worker"), turnId: "t", outcome: { kind: "completed" }, timeline: [] });
      expect((await systemBodies(sub.id)).some((b) => b.includes("stopped without reporting"))).toBe(false);
      expect((await systemBodies(parent.id)).some((b) => b.includes("stopped without reporting"))).toBe(false);
      expect(sentPrompts).toHaveLength(0);
    });

    it("reports a quiet worker once until it reports again", async () => {
      const { sub } = setupLeadAndWorker();
      const turn = async () => {
        await fire("agent.turn_started", { agent: agentRef("agent-worker"), turnId: "t" });
        await fire("agent.turn_ended", { agent: agentRef("agent-worker"), turnId: "t", outcome: { kind: "completed" }, timeline: [] });
      };
      const stops = async () => (await systemBodies(sub.id)).filter((b) => b.includes("stopped without reporting")).length;

      await turn();
      await turn();
      expect(await stops()).toBe(1);
      expect(sentPrompts).toHaveLength(1);

      await runTasksCli(["comment", sub.key, "--body", "Back on it"], store, domain, { threadId: "agent-worker" });
      await turn();
      expect(await stops()).toBe(2);
      expect(sentPrompts).toHaveLength(2);
    });

    it("comments and wakes the lead when a worker stops without reporting, once per turn", async () => {
      const { parent, sub } = setupLeadAndWorker();
      await fire("agent.turn_started", { agent: agentRef("agent-worker"), turnId: "t1" });
      const ended = {
        agent: agentRef("agent-worker"),
        turnId: "t1",
        outcome: { kind: "completed" },
        timeline: [
          { type: "assistant_message", text: "Earlier note." },
          { type: "assistant_message", text: `Should the API use REST or RPC? ${"x".repeat(400)}` },
        ],
      };
      await fire("agent.turn_ended", ended);

      const bodies = await systemBodies(sub.id);
      const stop = bodies.find((b) => b.startsWith("Backend worker stopped without reporting."));
      expect(stop).toContain("> Should the API use REST or RPC?");
      expect(stop!.length).toBeLessThan(400);
      expect(stop).not.toContain("—");
      expect(sentPrompts).toHaveLength(1);
      expect(sentPrompts[0]?.agentId).toBe("agent-lead");
      expect(sentPrompts[0]?.text).toContain(`${sub.key}: Backend worker stopped without reporting.`);
      expect(await systemBodies(parent.id)).toContain(`${sub.key}: Backend worker stopped without reporting.`);

      await fire("agent.turn_ended", ended);
      expect((await systemBodies(sub.id)).filter((b) => b.includes("stopped without reporting"))).toHaveLength(1);
      expect(sentPrompts).toHaveLength(1);
    });

    it("stays quiet when the worker commented or changed status, and for top-level tasks", async () => {
      const { parent, sub } = setupLeadAndWorker();
      const ended = (id: string) => ({ agent: agentRef(id), turnId: "t", outcome: { kind: "completed" }, timeline: [] });

      await fire("agent.turn_started", { agent: agentRef("agent-worker"), turnId: "t" });
      await runTasksCli(["comment", sub.key, "--body", "API done"], store, domain, { threadId: "agent-worker" });
      await fire("agent.turn_ended", ended("agent-worker"));

      await fire("agent.turn_started", { agent: agentRef("agent-worker"), turnId: "t" });
      // This checks that a status change counts as reporting; the evidence rule is tested elsewhere.
      vi.stubEnv("PASEO_TASKS_REQUIRE_EVIDENCE", "0");
      await runTasksCli(["update", sub.key, "--status", "in_review"], store, domain, { threadId: "agent-worker" });
      vi.unstubAllEnvs();
      await fire("agent.turn_ended", ended("agent-worker"));

      await fire("agent.turn_started", { agent: agentRef("agent-lead"), turnId: "t" });
      await fire("agent.turn_ended", ended("agent-lead"));

      expect((await systemBodies(sub.id)).some((b) => b.includes("stopped without reporting"))).toBe(false);
      expect((await systemBodies(parent.id)).some((b) => b.includes("stopped without reporting"))).toBe(false);
      expect(sentPrompts).toHaveLength(0);
    });

    it("keeps the failed comment for a failed worker turn and also wakes the lead", async () => {
      const { sub } = setupLeadAndWorker();
      await fire("agent.turn_started", { agent: agentRef("agent-worker"), turnId: "t" });
      await fire("agent.turn_ended", {
        agent: agentRef("agent-worker"),
        turnId: "t",
        outcome: { kind: "failed", error: { message: "boom" } },
        timeline: [],
      });
      const bodies = await systemBodies(sub.id);
      expect(bodies.some((b) => b.includes("failed"))).toBe(true);
      expect(bodies.some((b) => b.includes("stopped without reporting"))).toBe(false);
      expect(sentPrompts.map((p) => p.agentId)).toEqual(["agent-lead"]);
      expect(sentPrompts[0]?.text).toContain(`${sub.key}: Backend worker stopped without reporting.`);
    });

    it("tracks the first turn of a delegated worker", async () => {
      const { sub } = setupLeadAndWorker();
      await domain.delegate({ taskId: sub.id, presetId: domain.listPresets().presets[0]!.id });
      await fire("agent.turn_ended", { agent: agentRef("agent-uuid-1001"), turnId: "t", outcome: { kind: "completed" }, timeline: [] });
      expect((await systemBodies(sub.id)).some((b) => b.includes("stopped without reporting"))).toBe(true);
    });

    it("reconciles stale agent status once, on the first Paseo capture", async () => {
      const project = domain.createProject({ name: "Rec", prefix: "REC", color: "blue" }).project;
      const task = domain.createTask({ projectId: project.id, title: "Recover", status: "in_progress" });
      if (!task.ok) throw new Error("task not created");
      const upsert = (threadId: string, liveStatus: "working" | "completed") =>
        store.tasks.upsertTaskThread({ taskId: task.task.id, threadId, workspaceId: null, presetName: "Worker", title: threadId, liveStatus });
      upsert("agent-alive", "working");
      const gone = upsert("agent-gone", "working");
      upsert("agent-done", "completed");
      store.tasks.setTaskThreadHeartbeatId(gone.id, "hb_gone");

      const refresh = vi.fn(async (id: string) =>
        id === "agent-gone" ? null : { agent: { id, status: "idle", archivedAt: null }, project: null },
      );
      const paseo = { agents: { ref: (id: string) => ({ refresh: () => refresh(id) }) } };
      const runCli = vi.fn(async () => "{}");
      const capture = reconcileOnFirstCapture(store, runCli);
      capture(paseo as never);
      capture(paseo as never);

      await vi.waitFor(() => {
        const statuses = Object.fromEntries(
          domain.listTaskThreads({ taskId: task.task.id }).taskThreads.map((t) => [t.threadId, t.liveStatus]),
        );
        expect(statuses).toEqual({ "agent-alive": "idle", "agent-gone": "completed", "agent-done": "completed" });
      });
      await vi.waitFor(() => expect(runCli).toHaveBeenCalledWith(["heartbeat", "delete", "hb_gone"], { PASEO_AGENT_ID: "agent-gone" }));
      expect(refresh.mock.calls.map(([id]) => id).sort()).toEqual(["agent-alive", "agent-gone"]);
    });

    it("round-trips a preset check-in through the CLI", async () => {
      const created = await runTasksCli(
        ["preset", "create", "--name", "Worker", "--provider", "codex", "--model", "gpt-5.4", "--check-in", "0 9 * * 1-5"],
        store,
        domain,
      );
      expect(created.exitCode).toBe(0);
      expect((await runTasksCli(["preset", "show", "Worker"], store, domain)).stdout).toMatch(/^Check-in\s+0 9 \* \* 1-5$/m);
      expect(JSON.parse((await runTasksCli(["preset", "show", "Worker", "--json"], store, domain)).stdout).preset.checkIn).toBe("0 9 * * 1-5");

      expect((await runTasksCli(["preset", "update", "Worker", "--check-in", "0 * * * *"], store, domain)).exitCode).toBe(0);
      expect((await runTasksCli(["preset", "show", "Worker"], store, domain)).stdout).toMatch(/^Check-in\s+0 \* \* \* \*$/m);
      expect((await runTasksCli(["preset", "update", "Worker", "--check-in", "off"], store, domain)).exitCode).toBe(0);
      expect((await runTasksCli(["preset", "show", "Worker"], store, domain)).stdout).not.toMatch(/^Check-in/m);

      const invalid = await runTasksCli(["preset", "update", "Worker", "--check-in", "hourly"], store, domain);
      expect(invalid.exitCode).not.toBe(0);
      expect(domain.listPresets().presets.find((p) => p.name === "Worker")?.checkIn).toBeNull();
      expect((await runTasksCli(["--help"], store, domain)).stdout).toContain("--check-in");
    });

    function delegationSetup(runCli: ReturnType<typeof vi.fn>) {
      const heartbeatDomain = createDomainHandlers(store, () => mockPaseo as never, runCli as never);
      const project = heartbeatDomain.createProject({ name: "Beat", prefix: "BEAT", color: "blue", linkedBbProjectId: "prj_demo123" }).project;
      const task = heartbeatDomain.createTask({ projectId: project.id, title: "Long job", status: "todo" });
      if (!task.ok) throw new Error("task not created");
      const preset = heartbeatDomain.createPreset({
        name: "Checked worker",
        providerId: "codex",
        modelId: "gpt-5.4",
        reasoningLevel: "high",
        permissionMode: "auto",
        checkIn: "0 * * * *",
      }).preset;
      return { heartbeatDomain, task: task.task, preset };
    }

    it("creates a check-in heartbeat on delegation and deletes it when the task is done", async () => {
      const runCli = vi.fn(async (args: readonly string[]) => (args[1] === "create" ? JSON.stringify({ id: "hb_1" }) : "{}"));
      const { heartbeatDomain, task, preset } = delegationSetup(runCli);

      await heartbeatDomain.delegate({ taskId: task.id, presetId: domain.listPresets().presets[0]!.id });
      expect(runCli).not.toHaveBeenCalled();

      await heartbeatDomain.delegate({ taskId: task.id, presetId: preset.id });
      expect(runCli).toHaveBeenCalledTimes(1);
      const [args, env] = runCli.mock.calls[0]! as [string[], Record<string, string>];
      expect(env).toEqual({ PASEO_AGENT_ID: "agent-uuid-1001" });
      expect(args.slice(0, 3)).toEqual(["heartbeat", "create", "--cron=0 * * * *"]);
      expect(args).toContain("--json");
      expect(args.some((a) => a.startsWith("--timezone="))).toBe(true);
      expect(args.at(-1)).toBe(`Check-in: follow the Check-ins section of your instructions for ${task.key}.`);

      heartbeatDomain.updateTask({ taskId: task.id, status: "done" });
      await vi.waitFor(() => expect(runCli).toHaveBeenCalledWith(["heartbeat", "delete", "hb_1"], { PASEO_AGENT_ID: "agent-uuid-1001" }));
      heartbeatDomain.updateTask({ taskId: task.id, status: "canceled" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(runCli).toHaveBeenCalledTimes(2);
    });

    it("deletes a check-in heartbeat when its thread is detached", async () => {
      const runCli = vi.fn(async (args: readonly string[]) => (args[1] === "create" ? JSON.stringify({ id: "hb_2" }) : "{}"));
      const { heartbeatDomain, task, preset } = delegationSetup(runCli);
      await heartbeatDomain.delegate({ taskId: task.id, presetId: preset.id });
      heartbeatDomain.taskThreadsDetach({ taskId: task.id, threadId: "agent-uuid-1001" });
      await vi.waitFor(() => expect(runCli).toHaveBeenCalledWith(["heartbeat", "delete", "hb_2"], { PASEO_AGENT_ID: "agent-uuid-1001" }));
    });

    it("still delegates when the check-in heartbeat cannot be created", async () => {
      const runCli = vi.fn(async () => {
        throw new Error("paseo: command not found");
      });
      const { heartbeatDomain, task, preset } = delegationSetup(runCli);
      const result = await heartbeatDomain.delegate({ taskId: task.id, presetId: preset.id });
      expect(result.threadId).toBe("agent-uuid-1001");
      expect(heartbeatDomain.listTaskThreads({ taskId: task.id }).taskThreads).toHaveLength(1);
      const bodies = await systemBodies(task.id);
      expect(bodies.some((b) => b.startsWith("Check-in could not be scheduled") && b.includes("command not found"))).toBe(true);
    });
  });

  it("puts a task back in its old place when a move is undone with its old neighbors", () => {
    const project = domain.createProject({ name: "Ops", prefix: "OPS", color: "blue" }).project;
    const ids = ["A", "B", "C"].map((title) => {
      const res = domain.createTask({ projectId: project.id, title, status: "todo" });
      if (!res.ok) throw new Error("not created");
      return res.task.id;
    });
    const order = () =>
      domain.listTasks({ projectId: project.id, statuses: ["todo"] }).tasks.map((t) => t.title);
    expect(domain.boardMove({ taskId: ids[1]!, status: "done" }).ok).toBe(true);
    expect(order()).toEqual(["A", "C"]);
    expect(domain.boardMove({ taskId: ids[1]!, status: "todo", beforeTaskId: ids[0]!, afterTaskId: ids[2]! }).ok).toBe(true);
    expect(order()).toEqual(["A", "B", "C"]);
  });

  it("lists each task's most urgent agent state with its latest agent comment", () => {
    const project = domain.createProject({ name: "Ops", prefix: "OPS", color: "blue" }).project;
    const res = domain.createTask({ projectId: project.id, title: "Run tests", status: "in_progress" });
    if (!res.ok) throw new Error("not created");
    const taskId = res.task.id;
    const agentLine = () => {
      const task = domain.listTasks({ projectId: project.id }).tasks[0]!;
      return [task.agentStatus, task.agentNote];
    };
    expect(agentLine()).toEqual([null, null]);

    const thread = (threadId: string, liveStatus: "working" | "idle" | "completed" | "failed") =>
      store.tasks.upsertTaskThread({ taskId, threadId, workspaceId: null, presetName: "P", title: threadId, liveStatus });
    thread("agent-a", "completed");
    expect(agentLine()).toEqual(["completed", null]);
    expect(domain.listTasks({ projectId: project.id }).tasks[0]!.agentAt).not.toBeNull();
    thread("agent-b", "idle");
    expect(agentLine()).toEqual(["idle", null]);
    thread("agent-c", "working");
    store.tasks.createComment({ taskId, kind: "agent", authorName: "Worker", threadId: "agent-c", body: "Running tests" });
    store.tasks.createComment({ taskId, kind: "user", authorName: "You", body: "Thanks" });
    expect(agentLine()).toEqual(["working", "Running tests"]);
    thread("agent-b", "failed");
    expect(agentLine()).toEqual(["failed", "Running tests"]);
    store.db.prepare("UPDATE task_threads SET waiting_since = ? WHERE thread_id = 'agent-c'").run(new Date().toISOString());
    expect(agentLine()).toEqual(["waiting", "Running tests"]);
    expect(domain.getTask({ taskId }).task).toMatchObject({ agentStatus: "waiting", agentNote: "Running tests" });
  });

  describe("needs you and ideas", () => {
    type Handler = (event: unknown, context: unknown) => unknown;
    const hooks = new Map<string, Handler>();
    const fire = (name: string, event: unknown) =>
      hooks.get(name)!(event, { paseo: mockPaseo, signal: new AbortController().signal });
    const agentRef = (id: string) => ({ id, workspaceId: null, parentAgentId: null, provider: "codex", cwd: "/tmp", title: null });
    const needsYou = () =>
      domain.listTasks({ needsYou: true, limit: 100 }).tasks.map((t) => [t.key, t.idea, t.attention]);

    beforeEach(() => {
      hooks.clear();
      registerLifecycleHooks({ on: (name: string, handler: Handler) => hooks.set(name, handler) } as never, store, () => {});
    });

    it("lists tasks waiting for approval, failed, or in review until they are handled", async () => {
      const project = domain.createProject({ name: "Ops", prefix: "OPS", color: "blue" }).project;
      const create = (title: string, status: "in_progress" | "in_review" | "done") => {
        const res = domain.createTask({ projectId: project.id, title, status });
        if (!res.ok) throw new Error("not created");
        return res.task;
      };
      const waiting = create("Waits for approval", "in_progress");
      const failed = create("Agent failed", "in_progress");
      const closed = create("Done but failed", "done");
      create("In review", "in_review");
      create("Quiet", "in_progress");
      store.tasks.upsertTaskThread({ taskId: waiting.id, threadId: "agent-a", workspaceId: null, presetName: "P", title: "A", liveStatus: "working" });
      store.tasks.upsertTaskThread({ taskId: failed.id, threadId: "agent-b", workspaceId: null, presetName: "P", title: "B", liveStatus: "working" });
      store.tasks.upsertTaskThread({ taskId: closed.id, threadId: "agent-c", workspaceId: null, presetName: "P", title: "C", liveStatus: "failed" });

      expect(needsYou()).toEqual([["OPS-4", false, null]]);

      await fire("agent.permission_requested", { agent: agentRef("agent-a"), request: { id: "r1", name: "Bash", kind: "tool" } });
      await fire("agent.turn_ended", { agent: agentRef("agent-b"), turnId: "t", outcome: { kind: "failed", error: { message: "boom" } }, timeline: [] });
      expect(needsYou()).toEqual(
        expect.arrayContaining([["OPS-1", false, "waiting"], ["OPS-2", false, "failed"], ["OPS-4", false, null]]),
      );
      expect(needsYou()).toHaveLength(3);

      await fire("agent.permission_resolved", { agent: agentRef("agent-a"), requestId: "r1", resolution: { behavior: "allow" } });
      await fire("agent.turn_started", { agent: agentRef("agent-b"), turnId: "t2" });
      expect(needsYou()).toEqual([["OPS-4", false, null]]);
    });

    it("keeps proposed ideas off the board until the user accepts or dismisses them", async () => {
      const project = domain.createProject({ name: "Ops", prefix: "OPS", color: "blue" }).project;
      domain.createTask({ projectId: project.id, title: "Migrate the runner", status: "in_progress" });

      const proposed = await runTasksCli(["propose", "OPS-1", "--title", "Flaky login test", "--description", "Fails 1 in 5 runs."], store, domain);
      expect(proposed).toMatchObject({ exitCode: 0, stdout: "Proposed OPS-2  Flaky login test" });
      const bridge = await startTasksBridge(store, domain);
      try {
        const res = await fetch(`${bridge.url}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${bridge.token}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tasks_propose_idea", arguments: { key: "OPS-1", title: "Cache the fixtures" } } }),
        }).then((r) => r.json());
        expect(res.result.isError).toBe(false);
      } finally {
        await bridge.close();
      }

      expect(domain.listTasks({}).tasks.map((t) => t.key)).toEqual(["OPS-1"]);
      expect(needsYou()).toEqual(expect.arrayContaining([["OPS-2", true, null], ["OPS-3", true, null]]));
      expect(domain.getTaskByKey({ taskKey: "OPS-2" }).task?.description).toBe("Fails 1 in 5 runs.\n\nProposed while working on OPS-1.");
      const source = domain.getTaskByKey({ taskKey: "OPS-1" }).task!;
      expect((await domain.listComments({ taskId: source.id }, null)).comments.map((c) => c.body)).toContain(
        "Proposed idea OPS-2: Flaky login test",
      );

      const accept = domain.getTaskByKey({ taskKey: "OPS-2" }).task!;
      domain.updateTask({ taskId: accept.id, idea: false });
      const dismiss = domain.getTaskByKey({ taskKey: "OPS-3" }).task!;
      domain.updateTask({ taskId: dismiss.id, idea: false, status: "canceled" });

      expect(needsYou()).toEqual([]);
      expect(domain.listTasks({}).tasks.map((t) => [t.key, t.status])).toEqual(
        expect.arrayContaining([["OPS-2", "backlog"], ["OPS-3", "canceled"]]),
      );
      const bodies = async (taskId: string) => (await domain.listComments({ taskId }, null)).comments.map((c) => c.body);
      expect(await bodies(accept.id)).toContain("Idea accepted by You");
      expect(await bodies(dismiss.id)).toContain("Idea dismissed by You");
    });

    it("suggests work from an unlinked folder into Unsorted, then routes the folder once linked", async () => {
      // A lone project must not swallow work from folders it is not linked to.
      domain.createProject({ name: "Ops", prefix: "OPS", color: "blue" });
      const paseo = {
        agents: {
          ref: (id: string) => ({
            // Background workspaces are missing from workspaces.list, so the
            // project must come from the agent record.
            refresh: async () => ({ agent: { id, workspaceId: "wks_x", status: "idle", title: id, archivedAt: null }, project: { projectKey: "prj_new" } }),
          }),
        },
        workspaces: { list: async () => ({ entries: [] }) },
      };
      const local = createDomainHandlers(store, () => paseo as never);
      const cli = (argv: string[], threadId: string) => runTasksCli(argv, store, local, { threadId });

      expect((await cli(["context"], "s1")).stdout).toContain("Folder project: none yet. Still track real work here");
      const first = await cli(["propose", "--title", "Fix login"], "s1");
      expect(first.stdout).toContain("Suggested UNS-1  Fix login");
      const idea = local.getTaskByKey({ taskKey: "UNS-1" }).task!;
      expect(idea).toMatchObject({ idea: true, sourceBbProjectId: "prj_new" });
      expect(local.getAgentTasks({ agentId: "s1" }).tasks.map((t) => t.key)).toEqual(["UNS-1"]);
      // The composer pill lists the idea under the session that proposed it.
      expect(local.listSessionIdeas().ideas.map((i) => [i.threadId, i.task.key])).toEqual([["s1", "UNS-1"]]);
      expect((await cli(["context"], "s1")).stdout).toContain("UNS-1  Fix login  [suggested, awaiting approval]");

      // What the approval screen does: move, accept, link the folder.
      const prod = local.createProject({ name: "Product", prefix: "PROD", color: "blue" }).project;
      const moved = local.moveTaskToProject({ taskId: idea.id, projectId: prod.id });
      if (!moved.ok) throw new Error(moved.error.message);
      local.updateTask({ taskId: idea.id, idea: false });
      local.updateProject({ projectId: prod.id, linkedBbProjectId: "prj_new" });
      expect(local.getTaskByKey({ taskKey: moved.task.key }).task).toMatchObject({ idea: false, projectId: prod.id });
      expect(local.listSessionIdeas().ideas).toEqual([]);

      expect((await cli(["context"], "s2")).stdout).toMatch(/Folder project: PROD[\s\S]*PROD-1  Fix login/);
      const second = await cli(["propose", "--title", "Add rate limit"], "s2");
      expect(second.stdout).toContain("Suggested PROD-2");
      expect(local.listSessionIdeas().ideas.map((i) => [i.threadId, i.task.key])).toEqual([["s2", "PROD-2"]]);
      expect(local.getTaskByKey({ taskKey: "PROD-2" }).task?.sourceBbProjectId).toBeNull();
    });
  });

  it("transforms ::task{key=...} directives in assistant timeline messages", () => {
    const message = [
      "I created and started working on the task:",
      '::task{key="PROD-1" title="Ship task delegation"}',
      "Validation passed.",
    ].join("\n");

    const transformed = transformAssistantTaskDirectives(message, "complete");
    expect(transformed).toBeDefined();
    expect(transformed?.items).toHaveLength(3);
    expect(transformed?.items[1]).toMatchObject({
      type: "plugin",
      kind: "tasks-card",
      version: 1,
      data: {
        taskKey: "PROD-1",
        fallbackTitle: "Ship task delegation",
        valid: true,
        phase: "complete",
      },
    });
  });
});
