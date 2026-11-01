import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transformAssistantTaskDirectives } from "../shared/directive";
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
    domain = createDomainHandlers(store, () => mockPaseo as never);
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
      expect(mcpCall.result.isError).toBe(false);
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
      await runTasksCli(["update", sub.key, "--status", "in_review"], store, domain, { threadId: "agent-worker" });
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
