import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Reads Paseo Playbooks run files, if that plugin is installed, so a task can
// show the stage its run is at. Read only: Tasks never writes to Playbooks.
// ponytail: depends on Playbooks' run-file layout (version 1); a newer layout
// shows no stage instead of breaking. Upgrade to a Playbooks API if one appears.

export interface PlaybookStage {
  runId: string;
  playbookTitle: string;
  status: string;
  step: string | null;
  waiting: boolean;
  done: number;
  total: number;
  workspaceId: string | null;
}

interface RunFile {
  version: number;
  id: string;
  status: string;
  managerAgentId?: string | null;
  workspaceId?: string | null;
  inputs?: Record<string, unknown>;
  archivedAt?: string | null;
  updatedAt?: string;
  playbook: { title?: string; id: string; steps: { id: string; title?: string; kind?: string; afterTask?: string }[] };
  steps: Record<string, { status: string } | undefined>;
}

const LIVE = new Set(["ready", "running", "reported", "waiting", "queued"]);
const DONE = new Set(["completed", "skipped"]);
const ACTIVE_RUN = new Set(["running", "waiting_gate"]);

export function playbookRunsDir(): string {
  const home = process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
  return join(home, "plugin-data", "paseo-playbooks", "runs");
}

export function readPlaybookRuns(dir = playbookRunsDir()): RunFile[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return []; // Playbooks is not installed, or has no runs yet.
  }
  return names.flatMap((name) => {
    try {
      const run = JSON.parse(readFileSync(join(dir, name), "utf8")) as RunFile;
      return run.version === 1 && run.playbook?.steps && run.steps ? [run] : [];
    } catch {
      return [];
    }
  });
}

export function stageOfRun(run: RunFile): PlaybookStage {
  const main = run.playbook.steps.filter((step) => !step.afterTask);
  const status = (id: string) => run.steps[id]?.status ?? "pending";
  const current = main.find((step) => LIVE.has(status(step.id)));
  return {
    runId: run.id,
    playbookTitle: run.playbook.title || run.playbook.id,
    status: run.status,
    step: current ? current.title || current.id.charAt(0).toUpperCase() + current.id.slice(1).replace(/_/g, " ") : null,
    waiting: Boolean(current && current.kind === "gate" && status(current.id) === "waiting"),
    done: main.filter((step) => DONE.has(status(step.id))).length,
    total: main.length,
    workspaceId: run.workspaceId ?? null,
  };
}

// A task's run is one its attached agent manages, or one started with the
// task's key as an input. An active run wins over a finished one.
export function findPlaybookStage(
  runs: readonly RunFile[],
  task: { key: string; threadIds: readonly string[] },
): PlaybookStage | null {
  const mine = runs.filter(
    (run) =>
      !run.archivedAt &&
      ((run.managerAgentId && task.threadIds.includes(run.managerAgentId)) ||
        Object.values(run.inputs ?? {}).some((value) => value === task.key)),
  );
  mine.sort(
    (a, b) =>
      Number(ACTIVE_RUN.has(b.status)) - Number(ACTIVE_RUN.has(a.status)) ||
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
  );
  return mine[0] ? stageOfRun(mine[0]) : null;
}
