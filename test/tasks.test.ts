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
