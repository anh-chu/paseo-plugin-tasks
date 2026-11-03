import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { TaskStatus } from "../shared/constants";
import {
  attachTaskThreadRpc,
  createTaskRpc,
  getAgentTasksRpc,
  listProjectsRpc,
  listTasksRpc,
  listUnattachedThreadsRpc,
  type Project,
  type Task,
} from "../shared/contract";
import { formatRelativeTime } from "./badges";
import { MenuButton } from "./menu";

// The composer popover renders outside the plugin's RPC provider, so the
// picker calls through the client captured in contribute().
let adoptClient: PluginClientContext | null = null;
export function setAdoptClient(client: PluginClientContext) {
  adoptClient = client;
}
function client(): PluginClientContext {
  if (!adoptClient) throw new Error("Tasks client is not ready");
  return adoptClient;
}

const OPEN_STATUSES: TaskStatus[] = ["backlog", "todo", "in_progress", "in_review"];

// Creates a task for an existing session and attaches the session to it.
export async function adoptSession(input: {
  agentId: string;
  projectId: string;
  title: string;
  status?: TaskStatus;
}): Promise<Task> {
  const res = await client().rpc(createTaskRpc, {
    projectId: input.projectId,
    title: input.title,
    status: input.status ?? "in_progress",
  });
  if (!res.ok) throw new Error(res.error.message);
  await client().rpc(attachTaskThreadRpc, {
    taskId: res.task.id,
    threadId: input.agentId,
  });
  return res.task;
}

export async function attachSession(agentId: string, task: Task) {
  await client().rpc(attachTaskThreadRpc, { taskId: task.id, threadId: agentId });
}

export function AdoptPicker({
  theme,
  agentId,
  agentTitle,
  workspaceId,
  onAdopted,
  onOpenTask,
}: {
  theme: PluginTheme;
  agentId: string;
  agentTitle: string;
  workspaceId: string;
  onAdopted: (task: Task) => void;
  onOpenTask?: (task: Task) => void;
}) {
  const [title, setTitle] = useState(agentTitle);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [attached, setAttached] = useState<Task[]>([]);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<Task[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const [{ projects }, { tasks }, workspaces] = await Promise.all([
        client().rpc(listProjectsRpc, {}),
        client().rpc(getAgentTasksRpc, { agentId }),
        client().paseo.workspaces.list().catch(() => ({ entries: [] })),
      ]);
      if (!live) return;
      const paseoProjectId = workspaces.entries.find((w) => w.id === workspaceId)
        ?.projectId;
      const linked = projects.find((p) => p.linkedBbProjectId === paseoProjectId);
      setProjects(projects);
      setProjectId((linked ?? projects[0])?.id ?? null);
      setAttached(tasks);
    })().catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [agentId, workspaceId]);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      client()
        .rpc(listTasksRpc, {
          statuses: OPEN_STATUSES,
          search: query.trim() || undefined,
          limit: 6,
        })
        .then(({ tasks }) => live && setCandidates(tasks))
        .catch(() => undefined);
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);

  async function run(action: () => Promise<Task>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onAdopted(await action());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const attachedIds = new Set(attached.map((t) => t.id));
  const input = {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    fontSize: 12,
  } as const;
  const sectionLabel = {
    color: theme.colors.foregroundMuted,
    fontSize: 11,
    fontWeight: "600",
  } as const;

  return (
    <View style={{ gap: 8, padding: 12, minWidth: 280 }}>
      {attached.length > 0 ? (
        <View style={{ gap: 4 }}>
          <Text style={sectionLabel}>Attached</Text>
          {attached.map((task) => (
            <TaskRow
              key={task.id}
              theme={theme}
              task={task}
              onPress={() => onOpenTask?.(task)}
            />
          ))}
        </View>
      ) : null}

      <TextInput
        value={title}
        onChangeText={setTitle}
        placeholder="Task title"
        placeholderTextColor={theme.colors.foregroundMuted}
        accessibilityLabel="Task title"
        style={input}
      />
      {projects.length > 1 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
          {projects.map((p) => (
            <Pressable
              key={p.id}
              accessibilityRole="button"
              accessibilityState={{ selected: p.id === projectId }}
              onPress={() => setProjectId(p.id)}
              style={{
                paddingHorizontal: 8,
                paddingVertical: 3,
                borderRadius: 6,
                backgroundColor:
                  p.id === projectId ? theme.colors.surface2 : "transparent",
              }}
            >
              <Text
                style={{
                  color:
                    p.id === projectId
                      ? theme.colors.foreground
                      : theme.colors.foregroundMuted,
                  fontSize: 11,
                  fontWeight: "600",
                }}
              >
                {p.prefix}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        disabled={busy || !projectId || !title.trim()}
        onPress={() =>
          run(() =>
            adoptSession({ agentId, projectId: projectId!, title: title.trim() }),
          )
        }
        style={{
          paddingVertical: 7,
          borderRadius: 8,
          alignItems: "center",
          backgroundColor: theme.colors.accent,
          opacity: busy || !projectId || !title.trim() ? 0.5 : 1,
        }}
      >
        <Text
          style={{
            color: theme.colors.accentForeground,
            fontSize: 12,
            fontWeight: "700",
          }}
        >
          Create and attach
        </Text>
      </Pressable>

      <Text style={[sectionLabel, { marginTop: 4 }]}>Attach to</Text>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search tasks"
        placeholderTextColor={theme.colors.foregroundMuted}
        accessibilityLabel="Search tasks"
        style={input}
      />
      <View style={{ gap: 2 }}>
        {candidates
          .filter((t) => !attachedIds.has(t.id))
          .map((task) => (
            <TaskRow
              key={task.id}
              theme={theme}
              task={task}
              onPress={() =>
                run(async () => {
                  await attachSession(agentId, task);
                  return task;
                })
              }
            />
          ))}
      </View>
      {error ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 11 }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function TaskRow({
  theme,
  task,
  onPress,
}: {
  theme: PluginTheme;
  task: Task;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 8,
        paddingVertical: 6,
        borderRadius: 6,
        backgroundColor: pressed ? theme.colors.surface2 : "transparent",
      })}
    >
      <Text
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 11,
          fontWeight: "700",
          fontFamily: "monospace",
        }}
      >
        {task.key}
      </Text>
      <Text
        numberOfLines={1}
        style={{ color: theme.colors.foreground, fontSize: 12, flex: 1 }}
      >
        {task.title}
      </Text>
    </Pressable>
  );
}

// Board column listing sessions in the project's linked Paseo project that no
// task has adopted. Hidden when there are none.
export function SessionInbox({
  theme,
  compact,
  project,
  tasks,
  onChanged,
  openAgent,
}: {
  theme: PluginTheme;
  compact: boolean;
  project: Project;
  tasks: Task[];
  onChanged: () => void;
  openAgent?: (input: { readonly agentId: string }) => void;
}) {
  const toast = useToast();
  const query = useQuery({
    queryKey: ["tasks", "unattachedThreads", project.id],
    queryFn: () =>
      client().rpc(listUnattachedThreadsRpc, { projectId: project.id }),
    refetchInterval: 5000,
  });
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const threads = query.data?.threads ?? [];
  if (threads.length === 0) return null;

  if (!expanded) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Expand sessions without a task, ${threads.length}`}
        onPress={() => setExpanded(true)}
        style={{
          width: 40,
          minHeight: 280,
          borderRadius: 12,
          borderWidth: 1,
          borderStyle: "dashed",
          borderColor: theme.colors.border,
          paddingVertical: 12,
          alignItems: "center",
          gap: 8,
          overflow: "hidden",
        }}
      >
        <Icon name="ChevronRight" size={14} color={theme.colors.foregroundMuted} />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          {threads.length}
        </Text>
        {/* Rotated outside the strip's layout so the narrow width does not cut it. */}
        <View style={{ alignSelf: "stretch", height: 180 }}>
          <Text
            style={{
              position: "absolute",
              overflow: "hidden",
              top: 90 - 9,
              left: "50%",
              marginLeft: -90,
              width: 180,
              height: 18,
              lineHeight: 18,
              transform: [{ rotate: "90deg" }],
              color: theme.colors.foreground,
              fontSize: 13,
              fontWeight: "700",
            }}
          >
            Sessions without a task
          </Text>
        </View>
      </Pressable>
    );
  }

  async function run(action: () => Promise<string>) {
    if (busy) return;
    setBusy(true);
    try {
      toast.show(await action());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      void query.refetch();
      onChanged();
    }
  }

  const adopt = (t: (typeof threads)[number]) =>
    adoptSession({ agentId: t.id, projectId: project.id, title: t.title });
  const openTasks = tasks.filter(
    (t) => t.projectId === project.id && OPEN_STATUSES.includes(t.status),
  );
  const action = {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: theme.colors.border,
  } as const;
  const actionText = { color: theme.colors.foreground, fontSize: 11 } as const;

  return (
    <View
      style={{
        width: compact ? 240 : 260,
        borderRadius: 12,
        borderWidth: 1,
        borderStyle: "dashed",
        borderColor: theme.colors.border,
        padding: 10,
        gap: 8,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Collapse sessions without a task"
        onPress={() => setExpanded(false)}
        style={{ flexDirection: "row", gap: 6, paddingHorizontal: 4 }}
      >
        <Text
          style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "700" }}
        >
          Sessions without a task
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          {threads.length}
        </Text>
      </Pressable>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 8 }}>
        {threads.map((t) => (
          <View
            key={t.id}
            style={{
              borderRadius: 8,
              backgroundColor: theme.colors.surface1,
              borderWidth: 1,
              borderColor: theme.colors.border,
              padding: 8,
              gap: 6,
            }}
          >
            <Pressable
              accessibilityRole="button"
              onPress={() => openAgent?.({ agentId: t.id })}
            >
              <Text
                numberOfLines={2}
                style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}
              >
                {t.title}
              </Text>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                {t.provider} · {t.status} · {formatRelativeTime(t.updatedAt)}
              </Text>
            </Pressable>
            <View style={{ flexDirection: "row", gap: 6 }}>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() =>
                  run(async () => `Created ${(await adopt(t)).key}`)
                }
                style={action}
              >
                <Text style={actionText}>New task</Text>
              </Pressable>
              {openTasks.length > 0 ? (
                <MenuButton
                  accessibilityLabel={`Attach ${t.title} to a task`}
                  style={action}
                  items={() =>
                    openTasks.slice(0, 12).map((task) => ({
                      key: task.id,
                      label: `${task.key}  ${task.title}`,
                      onSelect: () =>
                        void run(async () => {
                          await attachSession(t.id, task);
                          return `Attached to ${task.key}`;
                        }),
                    }))
                  }
                >
                  <Text style={actionText}>Attach…</Text>
                </MenuButton>
              ) : null}
            </View>
          </View>
        ))}
      </ScrollView>
      {threads.length > 1 ? (
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() =>
            run(async () => {
              for (const t of threads) await adopt(t);
              return `Created ${threads.length} tasks`;
            })
          }
          style={[action, { alignItems: "center" }]}
        >
          <Text style={actionText}>Create a task for each</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
