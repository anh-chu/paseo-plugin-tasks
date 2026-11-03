import type { PluginTheme } from "@getpaseo/plugin";
import {
  useAgent,
  useRpc,
  useSettings,
  useWorkspace,
  type PluginAgentPanelProps,
  type PluginScreenProps,
  type PluginSidebarItemProps,
  type PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  PRIORITY_LABELS,
  STATUS_LABELS,
  TASK_PRIORITIES,
  TASK_SORTS,
  TASK_STATUSES,
  TASKS_PAGE_MAX_LIMIT,
  type TaskPriority,
  type TaskSort,
  type TaskStatus,
} from "../shared/constants";
import {
  boardMoveRpc,
  createTaskRpc,
  getAgentTasksRpc,
  listFoldersRpc,
  listLabelsRpc,
  listProjectsRpc,
  listTasksRpc,
  seedDemoRpc,
  sidebarOpenTaskCountRpc,
  sidebarSummaryRpc,
  updateTaskRpc,
  type Label,
  type Project,
  type Task,
} from "../shared/contract";
import { tasksSettings } from "../shared/settings";
import {
  AgentLine,
  LabelPill,
  PriorityBadge,
  PriorityIcon,
  ProjectDot,
  StatusBadge,
  StatusIcon,
} from "./badges";
import { SessionInbox } from "./adopt";
import { TaskDetailView } from "./detail-view";
import {
  columnAt,
  currentNeighbors,
  dropIndex,
  dropNeighbors,
  type Neighbors,
} from "./board-logic";
import {
  DraggableCard,
  DropLine,
  type BoardDrag,
  type Point,
} from "./board-drag";
import { MenuButton, MenuProvider, type MenuItem } from "./menu";
import { ManageModal, NewTaskModal } from "./modals";

const SORT_LABELS: Readonly<Record<TaskSort, string>> = {
  manual: "Manual",
  priority: "Priority",
  due: "Due date",
};

function TasksBoardAndListShell({
  theme,
  compact,
  initialTaskKey,
  initialProjectId,
  linkedPaseoProjectId,
  openAgent,
  openWorkspace,
}: {
  theme: PluginTheme;
  compact: boolean;
  initialTaskKey?: string | null;
  initialProjectId?: string | null;
  linkedPaseoProjectId?: string | null;
  openAgent?: (input: { readonly agentId: string }) => void;
  openWorkspace?: (input: { readonly workspaceId: string }) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const settings = useSettings(tasksSettings);

  const listProjects = useRpc(listProjectsRpc);
  const listFolders = useRpc(listFoldersRpc);
  const listTasks = useRpc(listTasksRpc);
  const listLabels = useRpc(listLabelsRpc);
  const boardMove = useRpc(boardMoveRpc);
  const updateTask = useRpc(updateTaskRpc);
  const createTask = useRpc(createTaskRpc);
  const sidebarSummary = useRpc(sidebarSummaryRpc);
  const seedDemo = useRpc(seedDemoRpc);

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    initialProjectId ?? null,
  );
  const [selectedTaskKey, setSelectedTaskKey] = useState<string | null>(
    initialTaskKey ?? null,
  );
  const [viewMode, setViewMode] = useState<"board" | "list">("board");
  const [groupBy, setGroupBy] = useState<"status" | "stage">("status");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);
  const [needsYou, setNeedsYou] = useState(false);
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority | null>(
    null,
  );
  const [sortBy, setSortBy] = useState<TaskSort>("manual");
  const [collapsedStatuses, setCollapsedStatuses] = useState<Set<string>>(
    new Set(),
  );

  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTaskDefaultStatus, setNewTaskDefaultStatus] =
    useState<TaskStatus>("todo");
  const [manageOpen, setManageOpen] = useState(false);
  const [manageTab, setManageTab] = useState<"projects" | "presets">(
    "projects",
  );
  const [seeding, setSeeding] = useState(false);

  useEffect(() => {
    if (settings.status === "ready") {
      setViewMode(settings.values.defaultView);
    }
  }, [settings.status]);

  useEffect(() => {
    if (initialTaskKey !== undefined) {
      setSelectedTaskKey(initialTaskKey || null);
    }
  }, [initialTaskKey]);

  useEffect(() => {
    if (initialProjectId !== undefined) {
      setSelectedProjectId(initialProjectId || null);
    }
  }, [initialProjectId]);

  const projectsQuery = useQuery({
    queryKey: ["tasks", "projects"],
    queryFn: () => listProjects({}),
    refetchInterval: 4000,
  });
  const foldersQuery = useQuery({
    queryKey: ["tasks", "folders"],
    queryFn: () => listFolders({}),
    refetchInterval: 5000,
  });
  const summaryQuery = useQuery({
    queryKey: ["tasks", "sidebarSummary"],
    queryFn: () => sidebarSummary({}),
    refetchInterval: 4000,
  });

  const projects = projectsQuery.data?.projects ?? [];
  const folders = foldersQuery.data?.folders ?? [];
  const summaries = summaryQuery.data?.projects ?? [];
  const summaryByProject = useMemo(
    () => new Map(summaries.map((s) => [s.projectId, s])),
    [summaries],
  );

  // Auto-select tracker project linked to workspace's Paseo project
  useEffect(() => {
    if (!selectedProjectId && linkedPaseoProjectId && projects.length > 0) {
      const match = projects.find(
        (p) => p.linkedBbProjectId === linkedPaseoProjectId,
      );
      if (match) setSelectedProjectId(match.id);
    }
  }, [linkedPaseoProjectId, projects, selectedProjectId]);

  const tasksQuery = useQuery({
    queryKey: [
      "tasks",
      "list",
      needsYou,
      selectedProjectId,
      activeOnly,
      priorityFilter,
      searchQuery,
      sortBy,
    ],
    queryFn: () =>
      listTasks(
        needsYou
          ? {
              needsYou: true,
              ...(priorityFilter ? { priorities: [priorityFilter] } : {}),
              ...(searchQuery.trim() ? { search: searchQuery.trim() } : {}),
              limit: TASKS_PAGE_MAX_LIMIT,
            }
          : {
              ...(selectedProjectId ? { projectId: selectedProjectId } : {}),
              ...(priorityFilter ? { priorities: [priorityFilter] } : {}),
              activeOnly,
              parentTaskId: null,
              ...(searchQuery.trim() ? { search: searchQuery.trim() } : {}),
              sort: sortBy,
              limit: 300,
            },
      ),
    refetchInterval: 3000,
  });
  const needsYouQuery = useQuery({
    queryKey: ["tasks", "needsYou"],
    queryFn: () =>
      listTasks({ needsYou: true, limit: TASKS_PAGE_MAX_LIMIT }),
    refetchInterval: 4000,
  });
  const needsYouCount = needsYouQuery.data?.tasks.length ?? 0;

  const allLabelsQuery = useQuery({
    queryKey: [
      "tasks",
      "allLabels",
      projects.map((p) => p.id).join(","),
    ],
    queryFn: async () => {
      const map = new Map<string, Label>();
      await Promise.all(
        projects.map(async (p) => {
          const res = await listLabels({ projectId: p.id });
          for (const l of res.labels) map.set(l.id, l);
        }),
      );
      return map;
    },
    enabled: projects.length > 0,
  });

  const tasks = useMemo(() => {
    const listed = tasksQuery.data?.tasks ?? [];
    return needsYou
      ? [...listed].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      : listed;
  }, [needsYou, tasksQuery.data]);
  const labelById = allLabelsQuery.data ?? new Map<string, Label>();
  const projectById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  );
  const currentProject =
    selectedProjectId && !needsYou
      ? projectById.get(selectedProjectId) ?? null
      : null;

  const showCompleted =
    settings.status === "ready" ? settings.values.showCompletedInBoard : true;
  const visibleStatuses = useMemo(
    () =>
      showCompleted
        ? TASK_STATUSES
        : TASK_STATUSES.filter((s) => s !== "done" && s !== "canceled"),
    [showCompleted],
  );

  const tasksByStatus = useMemo(() => {
    const map = new Map<TaskStatus, Task[]>();
    for (const s of TASK_STATUSES) map.set(s, []);
    for (const t of tasks) {
      map.get(t.status)?.push(t);
    }
    return map;
  }, [tasks]);

  // Needs you groups tasks by why they need the user, most urgent first.
  const listGroups = useMemo(() => {
    if (!needsYou) {
      return (
        [
          "in_progress",
          "in_review",
          "todo",
          "backlog",
          "done",
          "canceled",
        ] as const
      ).map((status) => ({
        key: status as string,
        status: status as TaskStatus,
        label: STATUS_LABELS[status],
        tasks: tasksByStatus.get(status) ?? [],
        canAdd: true,
      }));
    }
    const reason = (t: Task) =>
      t.idea
        ? "idea"
        : t.attention ?? (t.status === "in_review" ? "review" : null);
    return (
      [
        { key: "waiting", status: "in_progress", label: "Waiting for approval" },
        { key: "failed", status: "canceled", label: "Agent failed" },
        { key: "review", status: "in_review", label: "In review" },
        { key: "idea", status: "backlog", label: "Ideas" },
      ] as const
    )
      .map((group) => ({
        key: group.key as string,
        status: group.status as TaskStatus,
        label: group.label as string,
        tasks: tasks.filter((t) => reason(t) === group.key),
        canAdd: false,
      }))
      // Ideas always shows, so people learn that agents can propose them.
      .filter((group) => group.tasks.length > 0 || group.key === "idea");
  }, [needsYou, tasks, tasksByStatus]);

  const projectStages = currentProject?.stages ?? [];
  const groupByStage = groupBy === "stage" && projectStages.length > 0;
  const boardColumns = useMemo(() => {
    if (!groupByStage) {
      return visibleStatuses.map((status) => ({
        key: status,
        label: STATUS_LABELS[status],
        status: status as TaskStatus | null,
        stage: null as string | null,
        tasks: tasksByStatus.get(status) ?? [],
      }));
    }
    const visibleTasks = tasks.filter((t) =>
      (visibleStatuses as readonly TaskStatus[]).includes(t.status),
    );
    return [null, ...projectStages].map((stage) => ({
      key: stage ?? "",
      label: stage ?? "No stage",
      status: null as TaskStatus | null,
      stage,
      tasks: visibleTasks.filter((t) =>
        stage === null
          ? t.stage === null || !projectStages.includes(t.stage)
          : t.stage === stage,
      ),
    }));
  }, [groupByStage, projectStages, tasks, tasksByStatus, visibleStatuses]);

  // Status columns collapse on every board; stage columns per project.
  const collapsedColumns =
    settings.status === "ready" ? settings.values.collapsedBoardColumns : [];
  const columnCollapseKey = (key: string) =>
    groupByStage ? `stage:${selectedProjectId}:${key}` : `status:${key}`;
  function toggleColumnCollapsed(key: string) {
    if (settings.status !== "ready") return;
    const id = columnCollapseKey(key);
    void settings.save(
      {
        ...settings.values,
        collapsedBoardColumns: collapsedColumns.includes(id)
          ? collapsedColumns.filter((c) => c !== id)
          : [...collapsedColumns, id],
      },
      settings.revision,
    );
  }

  const toolbarMenuStyle = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: theme.colors.surface2,
  };

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
  };

  // The last move, undoable for a few seconds.
  const [lastMove, setLastMove] = useState<{
    id: number;
    message: string;
    undo: () => Promise<{ ok: boolean; error?: { message: string } }>;
  } | null>(null);
  useEffect(() => {
    if (!lastMove) return;
    const timer = setTimeout(() => setLastMove(null), 8000);
    return () => clearTimeout(timer);
  }, [lastMove]);

  async function handleUndoMove() {
    if (!lastMove) return;
    const move = lastMove;
    setLastMove(null);
    try {
      const res = await move.undo();
      if (!res.ok) toast.error(res.error?.message ?? "Could not undo");
      invalidateAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleMoveStage(task: Task, targetStage: string | null) {
    try {
      const res = await updateTask({
        taskId: task.id,
        stage: targetStage,
        authorName: "You",
      });
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      setLastMove({
        id: Date.now(),
        message: `Moved ${task.key} to ${targetStage ?? "No stage"}`,
        undo: () =>
          updateTask({ taskId: task.id, stage: task.stage, authorName: "You" }),
      });
      invalidateAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleMoveStatus(
    task: Task,
    targetStatus: TaskStatus,
    neighbors?: Neighbors,
  ) {
    // Remember the neighbors so undo puts the task back in its old place.
    const { beforeTaskId, afterTaskId } = currentNeighbors(tasks, task);
    try {
      const res = await boardMove({
        taskId: task.id,
        status: targetStatus,
        ...neighbors,
        authorName: "You",
      });
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      setLastMove({
        id: Date.now(),
        message:
          targetStatus === task.status
            ? `Moved ${task.key}`
            : `Moved ${task.key} to ${STATUS_LABELS[targetStatus]}`,
        undo: () =>
          boardMove({
            taskId: task.id,
            status: task.status,
            beforeTaskId,
            afterTaskId,
            authorName: "You",
          }),
      });
      invalidateAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  function statusMenuItems(task: Task): MenuItem[] {
    return TASK_STATUSES.map((s) => ({
      key: s,
      label: STATUS_LABELS[s],
      icon: <StatusIcon status={s} theme={theme} size={12} />,
      selected: task.status === s,
      onSelect: () => {
        if (s !== task.status) void handleMoveStatus(task, s);
      },
    }));
  }

  function stageMenuItems(task: Task): MenuItem[] {
    const taskStage =
      task.stage !== null && projectStages.includes(task.stage)
        ? task.stage
        : null;
    return [null, ...projectStages].map((stage) => ({
      key: stage ?? "",
      label: stage ?? "No stage",
      selected: taskStage === stage,
      onSelect: () => {
        if (stage !== taskStage) void handleMoveStage(task, stage);
      },
    }));
  }

  const cardMenuStyle = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 2,
    paddingHorizontal: 4,
    paddingVertical: 3,
    borderRadius: 5,
  };

  // Quick-create goes to the open project, else the one last created in.
  const [lastUsedProjectId, setLastUsedProjectId] = useState<string | null>(
    null,
  );
  const quickCreateProject =
    currentProject ??
    (lastUsedProjectId ? projectById.get(lastUsedProjectId) : undefined) ??
    projectById.get(
      [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
        ?.projectId ?? "",
    ) ??
    projects[0] ??
    null;

  async function handleQuickCreate(
    column: (typeof boardColumns)[number],
    project: Project,
    title: string,
  ): Promise<boolean> {
    try {
      const res = await createTask({
        projectId: project.id,
        title,
        status: column.status ?? "todo",
        priority: "none",
      });
      if (!res.ok) {
        toast.error(res.error.message);
        return false;
      }
      setLastUsedProjectId(project.id);
      if (!column.status && column.stage !== null) {
        const staged = await updateTask({
          taskId: res.task.id,
          stage: column.stage,
          authorName: "You",
        });
        if (!staged.ok) toast.error(staged.error.message);
      }
      invalidateAll();
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  // Board drag and drop. Geometry is measured when a drag starts; the board
  // and its columns stop scrolling until it ends.
  const [drag, setDrag] = useState<{
    taskId: string;
    point: Point;
    columnKey: string | null;
    index: number;
  } | null>(null);
  const dragLive = useRef(drag);
  const shellView = useRef<View>(null);
  const columnViews = useRef(new Map<string, View>());
  const cardViews = useRef(new Map<string, View>());
  const geometry = useRef({
    origin: { x: 0, y: 0 },
    columns: [] as { key: string; x: number; width: number }[],
    cards: new Map<string, { y: number; height: number }>(),
  });
  const suppressPressUntil = useRef(0);

  function dragTarget(taskId: string, point: Point) {
    const columnKey = columnAt(point.x, geometry.current.columns);
    const column = boardColumns.find((c) => c.key === columnKey);
    const cards = (column?.tasks ?? [])
      .filter((t) => t.id !== taskId)
      .map((t) => geometry.current.cards.get(t.id) ?? { y: 0, height: 0 });
    return { columnKey, index: dropIndex(point.y, cards) };
  }

  function setDragPoint(point: Point) {
    const live = dragLive.current;
    if (!live) return;
    dragLive.current = { ...live, point, ...dragTarget(live.taskId, point) };
    setDrag(dragLive.current);
  }

  async function handleDrop(
    task: Task,
    columnKey: string | null,
    index: number,
  ) {
    const column = boardColumns.find((c) => c.key === columnKey);
    if (!column) return;
    if (!column.status) {
      const taskStage =
        task.stage !== null && projectStages.includes(task.stage)
          ? task.stage
          : null;
      if (column.stage !== taskStage) {
        await handleMoveStage(task, column.stage);
        return;
      }
    }
    const status = column.status ?? task.status;
    const reorder = sortBy === "manual";
    if (status === task.status && !reorder) return;
    const neighbors = reorder
      ? dropNeighbors(column.tasks, task, index, status)
      : { beforeTaskId: null, afterTaskId: null };
    if (status === task.status) {
      const old = currentNeighbors(tasks, task);
      if (!neighbors.beforeTaskId && !neighbors.afterTaskId) return;
      if (
        neighbors.beforeTaskId === old.beforeTaskId &&
        neighbors.afterTaskId === old.afterTaskId
      ) {
        return;
      }
    }
    await handleMoveStatus(task, status, neighbors);
  }

  const boardDrag: BoardDrag = {
    start(taskId, point) {
      dragLive.current = { taskId, point, columnKey: null, index: 0 };
      setDrag(dragLive.current);
      shellView.current?.measureInWindow((x, y) => {
        geometry.current.origin = { x, y };
      });
      geometry.current.columns = [];
      geometry.current.cards = new Map();
      columnViews.current.forEach((view, key) =>
        view.measureInWindow((x, _y, width) => {
          geometry.current.columns = [
            ...geometry.current.columns.filter((c) => c.key !== key),
            { key, x, width },
          ];
          if (dragLive.current) setDragPoint(dragLive.current.point);
        }),
      );
      cardViews.current.forEach((view, id) =>
        view.measureInWindow((_x, y, _width, height) => {
          geometry.current.cards.set(id, { y, height });
          if (dragLive.current) setDragPoint(dragLive.current.point);
        }),
      );
    },
    move: setDragPoint,
    end(point) {
      const live = dragLive.current;
      dragLive.current = null;
      setDrag(null);
      suppressPressUntil.current = Date.now() + 300;
      if (!live) return;
      const task = tasks.find((t) => t.id === live.taskId);
      const target = dragTarget(live.taskId, point);
      if (task) void handleDrop(task, target.columnKey, target.index);
    },
    cancel() {
      dragLive.current = null;
      setDrag(null);
    },
  };

  async function handleSeedDemo() {
    setSeeding(true);
    try {
      const res = await seedDemo({
        ...(linkedPaseoProjectId
          ? { linkedProjectId: linkedPaseoProjectId }
          : {}),
      });
      invalidateAll();
      toast.show(
        `Created ${res.projectsCreated} sample projects & ${res.tasksCreated} tasks`,
        { variant: "success" },
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSeeding(false);
    }
  }

  // On compact layouts, when a task is open, show full-screen detail with a back bar
  if (compact && selectedTaskKey) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
        <TaskDetailView
          taskKey={selectedTaskKey}
          theme={theme}
          compact={compact}
          onSelectTaskKey={setSelectedTaskKey}
          onClose={() => setSelectedTaskKey(null)}
          onOpenManagePresets={() => {
            setManageTab("presets");
            setManageOpen(true);
          }}
          openAgent={openAgent}
          openWorkspace={openWorkspace}
        />
        <ManageModal
          open={manageOpen}
          onOpenChange={setManageOpen}
          initialTab={manageTab}
          theme={theme}
        />
      </View>
    );
  }

  return (
    <View
      ref={shellView}
      style={{
        flex: 1,
        flexDirection: compact ? "column" : "row",
        backgroundColor: theme.colors.surface0,
      }}
    >
      {/* Left Navigation Rail (Wide Desktop) */}
      {!compact ? (
        <View
          style={{
            width: 220,
            borderRightWidth: 1,
            borderRightColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
            padding: 12,
            gap: 10,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingHorizontal: 4,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
              <Icon name="ListTodo" size={16} color={theme.colors.accent} />
              <Text
                style={{
                  color: theme.colors.foreground,
                  fontSize: 14,
                  fontWeight: "700",
                }}
              >
                Tasks
              </Text>
            </View>
          </View>

          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 4 }}>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setSelectedProjectId(null);
                setActiveOnly(false);
                setNeedsYou(false);
              }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                paddingHorizontal: 10,
                paddingVertical: 7,
                borderRadius: 8,
                backgroundColor:
                  selectedProjectId === null && !activeOnly && !needsYou
                    ? theme.colors.surface2
                    : "transparent",
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Icon
                  name="Layers"
                  size={14}
                  color={theme.colors.foreground}
                />
                <Text
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 13,
                    fontWeight:
                      selectedProjectId === null && !activeOnly && !needsYou
                        ? "700"
                        : "500",
                  }}
                >
                  All Tasks
                </Text>
              </View>
              <Text
                style={{
                  color: theme.colors.foregroundMuted,
                  fontSize: 11,
                }}
              >
                {summaries.reduce((acc, s) => acc + s.taskCount, 0)}
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setActiveOnly((prev) => !prev);
                setNeedsYou(false);
              }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                paddingHorizontal: 10,
                paddingVertical: 7,
                borderRadius: 8,
                backgroundColor: activeOnly
                  ? theme.colors.surface2
                  : "transparent",
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Icon name="Play" size={14} color="#f59e0b" />
                <Text
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 13,
                    fontWeight: activeOnly ? "700" : "500",
                  }}
                >
                  Active Agents
                </Text>
              </View>
              <Text style={{ color: "#f59e0b", fontSize: 11, fontWeight: "700" }}>
                {summaries.reduce((acc, s) => acc + s.activeAgentCount, 0)}
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setNeedsYou(true);
                setActiveOnly(false);
              }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                paddingHorizontal: 10,
                paddingVertical: 7,
                borderRadius: 8,
                backgroundColor: needsYou
                  ? theme.colors.surface2
                  : "transparent",
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <StatusIcon status="in_review" theme={theme} size={14} />
                <Text
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 13,
                    fontWeight: needsYou ? "700" : "500",
                  }}
                >
                  Needs you
                </Text>
              </View>
              {needsYouCount > 0 ? (
                <Text
                  style={{
                    color: theme.colors.foregroundMuted,
                    fontSize: 11,
                  }}
                >
                  {needsYouCount}
                </Text>
              ) : null}
            </Pressable>

            <View
              style={{
                height: 1,
                backgroundColor: theme.colors.border,
                marginVertical: 6,
              }}
            />

            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 10,
                fontWeight: "700",
                paddingHorizontal: 8,
                marginBottom: 2,
              }}
            >
              PROJECTS
            </Text>

            {folders.map((folder) => {
              const folderProjects = projects.filter(
                (p) => p.folderId === folder.id,
              );
              return (
                <View key={folder.id} style={{ gap: 2 }}>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                      paddingHorizontal: 8,
                      paddingVertical: 4,
                    }}
                  >
                    <Icon
                      name="Folder"
                      size={12}
                      color={theme.colors.foregroundMuted}
                    />
                    <Text
                      style={{
                        color: theme.colors.foregroundMuted,
                        fontSize: 11,
                        fontWeight: "600",
                      }}
                    >
                      {folder.name}
                    </Text>
                  </View>
                  {folderProjects.map((project) => {
                    const active =
                      selectedProjectId === project.id && !needsYou;
                    const sum = summaryByProject.get(project.id);
                    return (
                      <Pressable
                        key={project.id}
                        accessibilityRole="button"
                        onPress={() => {
                          setSelectedProjectId(project.id);
                          setNeedsYou(false);
                        }}
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          justifyContent: "space-between",
                          paddingLeft: 18,
                          paddingRight: 10,
                          paddingVertical: 6,
                          borderRadius: 8,
                          backgroundColor: active
                            ? theme.colors.surface2
                            : "transparent",
                        }}
                      >
                        <View
                          style={{
                            flexDirection: "row",
                            alignItems: "center",
                            gap: 7,
                            flex: 1,
                          }}
                        >
                          <ProjectDot color={project.color} size={8} />
                          <Text
                            numberOfLines={1}
                            style={{
                              color: theme.colors.foreground,
                              fontSize: 12,
                              fontWeight: active ? "700" : "500",
                              flex: 1,
                            }}
                          >
                            {project.name}
                          </Text>
                        </View>
                        <Text
                          style={{
                            color: theme.colors.foregroundMuted,
                            fontSize: 11,
                          }}
                        >
                          {sum?.taskCount ?? 0}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              );
            })}

            {projects
              .filter((p) => p.folderId === null)
              .map((project) => {
                const active = selectedProjectId === project.id && !needsYou;
                const sum = summaryByProject.get(project.id);
                return (
                  <Pressable
                    key={project.id}
                    accessibilityRole="button"
                    onPress={() => {
                      setSelectedProjectId(project.id);
                      setNeedsYou(false);
                    }}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                      paddingHorizontal: 10,
                      paddingVertical: 7,
                      borderRadius: 8,
                      backgroundColor: active
                        ? theme.colors.surface2
                        : "transparent",
                    }}
                  >
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 8,
                        flex: 1,
                      }}
                    >
                      <ProjectDot color={project.color} size={8} />
                      <Text
                        numberOfLines={1}
                        style={{
                          color: theme.colors.foreground,
                          fontSize: 12,
                          fontWeight: active ? "700" : "500",
                          flex: 1,
                        }}
                      >
                        {project.name}
                      </Text>
                    </View>
                    <Text
                      style={{
                        color: theme.colors.foregroundMuted,
                        fontSize: 11,
                      }}
                    >
                      {sum?.taskCount ?? 0}
                    </Text>
                  </Pressable>
                );
              })}
          </ScrollView>

          <View style={{ gap: 6, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 8 }}>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setManageTab("projects");
                setManageOpen(true);
              }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingHorizontal: 10,
                paddingVertical: 7,
                borderRadius: 8,
                backgroundColor: theme.colors.surface2,
              }}
            >
              <Icon name="Folder" size={13} color={theme.colors.foreground} />
              <Text
                style={{
                  color: theme.colors.foreground,
                  fontSize: 12,
                  fontWeight: "600",
                }}
              >
                Projects & Labels
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setManageTab("presets");
                setManageOpen(true);
              }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingHorizontal: 10,
                paddingVertical: 7,
                borderRadius: 8,
                backgroundColor: theme.colors.surface2,
              }}
            >
              <Icon name="Settings" size={13} color={theme.colors.foreground} />
              <Text
                style={{
                  color: theme.colors.foreground,
                  fontSize: 12,
                  fontWeight: "600",
                }}
              >
                Agent Presets
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* Main Content Area */}
      <View style={{ flex: 1, minWidth: 0 }}>
        {/* Top Toolbar */}
        <View
          style={{
            paddingHorizontal: compact ? 12 : 18,
            paddingVertical: 12,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
            gap: 10,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              {currentProject ? (
                <ProjectDot color={currentProject.color} size={10} />
              ) : null}
              <Text
                style={{
                  color: theme.colors.foreground,
                  fontSize: compact ? 16 : 18,
                  fontWeight: "700",
                }}
              >
                {needsYou
                  ? "Needs you"
                  : currentProject
                    ? `${currentProject.prefix} · ${currentProject.name}`
                    : "All Tasks"}
              </Text>
              {currentProject?.linkedBbProjectId ? (
                <View
                  style={{
                    paddingHorizontal: 7,
                    paddingVertical: 2,
                    borderRadius: 999,
                    backgroundColor: theme.colors.surface2,
                  }}
                >
                  <Text
                    style={{
                      color: theme.colors.foregroundMuted,
                      fontSize: 10,
                      fontWeight: "600",
                    }}
                  >
                    Linked to Paseo Project
                  </Text>
                </View>
              ) : null}
            </View>

            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              {/* View Switcher */}
              <View
                style={{
                  display: needsYou ? "none" : "flex",
                  flexDirection: "row",
                  padding: 3,
                  borderRadius: 8,
                  backgroundColor: theme.colors.surface2,
                }}
              >
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setViewMode("board")}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 4,
                    borderRadius: 6,
                    backgroundColor:
                      viewMode === "board"
                        ? theme.colors.surface0
                        : "transparent",
                  }}
                >
                  <Text
                    style={{
                      color: theme.colors.foreground,
                      fontSize: 12,
                      fontWeight: viewMode === "board" ? "700" : "500",
                    }}
                  >
                    Board
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setViewMode("list")}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 4,
                    borderRadius: 6,
                    backgroundColor:
                      viewMode === "list"
                        ? theme.colors.surface0
                        : "transparent",
                  }}
                >
                  <Text
                    style={{
                      color: theme.colors.foreground,
                      fontSize: 12,
                      fontWeight: viewMode === "list" ? "700" : "500",
                    }}
                  >
                    List
                  </Text>
                </Pressable>
              </View>

              {viewMode === "board" && projectStages.length > 0 ? (
                <View
                  style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
                >
                  <Text
                    style={{
                      color: theme.colors.foregroundMuted,
                      fontSize: 12,
                    }}
                  >
                    Group by
                  </Text>
                  <View
                    style={{
                      flexDirection: "row",
                      padding: 3,
                      borderRadius: 8,
                      backgroundColor: theme.colors.surface2,
                    }}
                  >
                    {(["status", "stage"] as const).map((mode) => (
                      <Pressable
                        key={mode}
                        accessibilityRole="button"
                        onPress={() => setGroupBy(mode)}
                        style={{
                          paddingHorizontal: 10,
                          paddingVertical: 4,
                          borderRadius: 6,
                          backgroundColor:
                            groupBy === mode
                              ? theme.colors.surface0
                              : "transparent",
                        }}
                      >
                        <Text
                          style={{
                            color: theme.colors.foreground,
                            fontSize: 12,
                            fontWeight: groupBy === mode ? "700" : "500",
                          }}
                        >
                          {mode === "status" ? "Status" : "Stage"}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              ) : null}

              {compact ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    setManageTab("projects");
                    setManageOpen(true);
                  }}
                  style={{
                    paddingHorizontal: 9,
                    paddingVertical: 6,
                    borderRadius: 8,
                    backgroundColor: theme.colors.surface2,
                  }}
                >
                  <Icon
                    name="Settings"
                    size={14}
                    color={theme.colors.foreground}
                  />
                </Pressable>
              ) : null}

              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setNewTaskDefaultStatus("todo");
                  setNewTaskOpen(true);
                }}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 5,
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: 8,
                  backgroundColor: theme.colors.accent,
                }}
              >
                <Icon
                  name="Plus"
                  size={13}
                  color={theme.colors.accentForeground}
                />
                <Text
                  style={{
                    color: theme.colors.accentForeground,
                    fontSize: 12,
                    fontWeight: "700",
                  }}
                >
                  New Task
                </Text>
              </Pressable>
            </View>
          </View>

          {/* Compact project chips */}
          {compact && projects.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 6 }}
            >
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setSelectedProjectId(null);
                  setNeedsYou(false);
                }}
                style={{
                  paddingHorizontal: 9,
                  paddingVertical: 5,
                  borderRadius: 999,
                  backgroundColor:
                    selectedProjectId === null && !needsYou
                      ? theme.colors.accent
                      : theme.colors.surface2,
                }}
              >
                <Text
                  style={{
                    color:
                      selectedProjectId === null && !needsYou
                        ? theme.colors.accentForeground
                        : theme.colors.foreground,
                    fontSize: 11,
                    fontWeight: "600",
                  }}
                >
                  All
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => setNeedsYou(true)}
                style={{
                  paddingHorizontal: 9,
                  paddingVertical: 5,
                  borderRadius: 999,
                  backgroundColor: needsYou
                    ? theme.colors.accent
                    : theme.colors.surface2,
                }}
              >
                <Text
                  style={{
                    color: needsYou
                      ? theme.colors.accentForeground
                      : theme.colors.foreground,
                    fontSize: 11,
                    fontWeight: "600",
                  }}
                >
                  {needsYouCount > 0 ? `Needs you ${needsYouCount}` : "Needs you"}
                </Text>
              </Pressable>
              {projects.map((p) => {
                const active = selectedProjectId === p.id && !needsYou;
                return (
                  <Pressable
                    key={p.id}
                    accessibilityRole="button"
                    onPress={() => {
                      setSelectedProjectId(p.id);
                      setNeedsYou(false);
                    }}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 5,
                      paddingHorizontal: 9,
                      paddingVertical: 5,
                      borderRadius: 999,
                      backgroundColor: active
                        ? theme.colors.accent
                        : theme.colors.surface2,
                    }}
                  >
                    <ProjectDot color={p.color} size={7} />
                    <Text
                      style={{
                        color: active
                          ? theme.colors.accentForeground
                          : theme.colors.foreground,
                        fontSize: 11,
                        fontWeight: "600",
                      }}
                    >
                      {p.prefix}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          ) : null}

          {/* Filter & Search Bar */}
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 8,
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingHorizontal: 10,
                paddingVertical: 5,
                borderRadius: 8,
                backgroundColor: theme.colors.surface2,
                minWidth: 180,
                flex: 1,
              }}
            >
              <Icon
                name="Search"
                size={13}
                color={theme.colors.foregroundMuted}
              />
              <TextInput
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder="Filter by key (TASKS-1), title, or description…"
                placeholderTextColor={theme.colors.foregroundMuted}
                style={{
                  flex: 1,
                  color: theme.colors.foreground,
                  fontSize: 12,
                  paddingVertical: 2,
                }}
              />
              {searchQuery ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setSearchQuery("")}
                >
                  <Icon
                    name="X"
                    size={12}
                    color={theme.colors.foregroundMuted}
                  />
                </Pressable>
              ) : null}
            </View>

            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              <MenuButton
                accessibilityLabel="Filter by priority"
                items={() => [
                  {
                    key: "all",
                    label: "All priorities",
                    selected: priorityFilter === null,
                    onSelect: () => setPriorityFilter(null),
                  },
                  ...TASK_PRIORITIES.filter((p) => p !== "none").map((p) => ({
                    key: p,
                    label: PRIORITY_LABELS[p],
                    icon: <PriorityIcon priority={p} theme={theme} size={12} />,
                    selected: priorityFilter === p,
                    onSelect: () => setPriorityFilter(p),
                  })),
                ]}
                style={toolbarMenuStyle}
              >
                <Icon
                  name="Filter"
                  size={12}
                  color={theme.colors.foregroundMuted}
                />
                <Text
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 11,
                    fontWeight: priorityFilter ? "700" : "500",
                  }}
                >
                  {priorityFilter ? PRIORITY_LABELS[priorityFilter] : "Filter"}
                </Text>
              </MenuButton>

              {needsYou ? null : (
                <MenuButton
                  accessibilityLabel="Sort tasks"
                  items={() =>
                    TASK_SORTS.map((s) => ({
                      key: s,
                      label: SORT_LABELS[s],
                      selected: sortBy === s,
                      onSelect: () => setSortBy(s),
                    }))
                  }
                  style={toolbarMenuStyle}
                >
                  <Icon
                    name="ArrowUpDown"
                    size={12}
                    color={theme.colors.foregroundMuted}
                  />
                  <Text
                    style={{
                      color: theme.colors.foreground,
                      fontSize: 11,
                      fontWeight: "500",
                    }}
                  >
                    Sort: {SORT_LABELS[sortBy]}
                  </Text>
                </MenuButton>
              )}
            </View>
          </View>
        </View>

        {/* Empty State when no projects exist */}
        {projects.length === 0 && !projectsQuery.isLoading ? (
          <View
            style={{
              flex: 1,
              padding: 32,
              alignItems: "center",
              justifyContent: "center",
              gap: 14,
            }}
          >
            <Icon name="ListTodo" size={36} color={theme.colors.accent} />
            <Text
              style={{
                color: theme.colors.foreground,
                fontSize: 18,
                fontWeight: "700",
              }}
            >
              Welcome to Paseo Tasks
            </Text>
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 13,
                textAlign: "center",
                maxWidth: 440,
                lineHeight: 20,
              }}
            >
              Create a tracker project and link it to a Paseo project to plan
              work, dispatch tasks to worker agents using presets, and steer
              agents from task comments.
            </Text>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Pressable
                accessibilityRole="button"
                disabled={seeding}
                onPress={() => void handleSeedDemo()}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 9,
                  borderRadius: 8,
                  backgroundColor: theme.colors.accent,
                }}
              >
                <Text
                  style={{
                    color: theme.colors.accentForeground,
                    fontSize: 13,
                    fontWeight: "700",
                  }}
                >
                  {seeding ? "Seeding…" : "Seed Sample Projects & Tasks"}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setManageTab("projects");
                  setManageOpen(true);
                }}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 9,
                  borderRadius: 8,
                  backgroundColor: theme.colors.surface2,
                }}
              >
                <Text
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 13,
                    fontWeight: "600",
                  }}
                >
                  Create Project
                </Text>
              </Pressable>
            </View>
          </View>
        ) : (
          /* Board or List + Optional Split Detail Pane */
          <View style={{ flex: 1, flexDirection: "row", minHeight: 0 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              {viewMode === "board" && !needsYou ? (
                <ScrollView
                  horizontal
                  scrollEnabled={!drag}
                  style={{ flex: 1 }}
                  contentContainerStyle={{
                    padding: compact ? 12 : 16,
                    gap: 12,
                  }}
                >
                  {currentProject?.linkedBbProjectId ? (
                    <SessionInbox
                      theme={theme}
                      compact={compact}
                      project={currentProject}
                      tasks={tasks}
                      onChanged={invalidateAll}
                      openAgent={openAgent}
                    />
                  ) : null}
                  {boardColumns.map((column) => {
                    const { status } = column;
                    const columnTasks = column.tasks;
                    const dropTarget = drag?.columnKey === column.key;
                    const draggedTask = drag
                      ? tasks.find((t) => t.id === drag.taskId)
                      : undefined;
                    // The insertion line shows where a manual-order drop lands.
                    const dropLineAt =
                      dropTarget && sortBy === "manual" ? drag.index : null;
                    const otherTasks = columnTasks.filter(
                      (t) => t.id !== drag?.taskId,
                    );

                    if (collapsedColumns.includes(columnCollapseKey(column.key))) {
                      return (
                        <Pressable
                          key={column.key}
                          accessibilityRole="button"
                          accessibilityLabel={`Expand ${column.label}, ${columnTasks.length} tasks`}
                          onPress={() => toggleColumnCollapsed(column.key)}
                          style={{
                            width: 40,
                            minHeight: 280,
                            borderRadius: 12,
                            backgroundColor: theme.colors.surface1,
                            borderWidth: 1,
                            borderColor: theme.colors.border,
                            paddingVertical: 12,
                            alignItems: "center",
                            gap: 8,
                            overflow: "hidden",
                          }}
                        >
                          <Icon
                            name="ChevronRight"
                            size={14}
                            color={theme.colors.foregroundMuted}
                          />
                          {status ? (
                            <StatusIcon status={status} theme={theme} size={14} />
                          ) : null}
                          <Text
                            style={{
                              color: theme.colors.foregroundMuted,
                              fontSize: 12,
                            }}
                          >
                            {columnTasks.length}
                          </Text>
                          {/* Rotated outside the strip's layout so the narrow width does not cut it. */}
                          <View style={{ alignSelf: "stretch", height: 180 }}>
                            {/* No numberOfLines: on web it caps the width at the 40px strip. */}
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
                              {column.label}
                            </Text>
                          </View>
                        </Pressable>
                      );
                    }

                    return (
                      <View
                        key={column.key}
                        ref={(view) => {
                          if (view) columnViews.current.set(column.key, view);
                          else columnViews.current.delete(column.key);
                        }}
                        style={{
                          width: compact ? 260 : 285,
                          borderRadius: 12,
                          backgroundColor: theme.colors.surface1,
                          borderWidth: 1,
                          borderColor:
                            dropTarget && draggedTask
                              ? theme.colors.foregroundMuted
                              : theme.colors.border,
                          padding: 10,
                          gap: 8,
                        }}
                      >
                        <View
                          style={{
                            flexDirection: "row",
                            alignItems: "center",
                            justifyContent: "space-between",
                            paddingHorizontal: 4,
                            paddingVertical: 2,
                          }}
                        >
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Collapse ${column.label}`}
                            onPress={() => toggleColumnCollapsed(column.key)}
                            style={{
                              flexDirection: "row",
                              alignItems: "center",
                              gap: 6,
                            }}
                          >
                            {status ? (
                              <StatusIcon
                                status={status}
                                theme={theme}
                                size={14}
                              />
                            ) : null}
                            <Text
                              style={{
                                color: theme.colors.foreground,
                                fontSize: 13,
                                fontWeight: "700",
                              }}
                            >
                              {column.label}
                            </Text>
                            <Text
                              style={{
                                color: theme.colors.foregroundMuted,
                                fontSize: 12,
                              }}
                            >
                              {columnTasks.length}
                            </Text>
                          </Pressable>
                        </View>

                        {quickCreateProject &&
                        status !== "done" &&
                        status !== "canceled" ? (
                          <QuickCreate
                            theme={theme}
                            placeholder={`New ${quickCreateProject.prefix} task`}
                            onSubmit={(title) =>
                              handleQuickCreate(column, quickCreateProject, title)
                            }
                          />
                        ) : null}

                        <ScrollView
                          scrollEnabled={!drag}
                          style={{ flex: 1 }}
                          contentContainerStyle={{ gap: 8, paddingBottom: 8 }}
                        >
                          {columnTasks.map((task) => {
                            const selected = selectedTaskKey === task.key;
                            const proj = projectById.get(task.projectId);
                            const taskLabels = task.labelIds
                              .map((id) => labelById.get(id))
                              .filter((l): l is Label => Boolean(l));
                            const dropLineHere =
                              dropLineAt !== null &&
                              otherTasks[dropLineAt]?.id === task.id;

                            return (
                              <React.Fragment key={task.id}>
                                {dropLineHere ? (
                                  <DropLine theme={theme} />
                                ) : null}
                                <DraggableCard
                                  taskId={task.id}
                                  drag={boardDrag}
                                  cardRef={(view) => {
                                    if (view) cardViews.current.set(task.id, view);
                                    else cardViews.current.delete(task.id);
                                  }}
                                  dragging={drag?.taskId === task.id}
                                >
                                  <Pressable
                                    accessibilityRole="button"
                                    onPress={() => {
                                      if (Date.now() < suppressPressUntil.current) {
                                        return;
                                      }
                                      setSelectedTaskKey(task.key);
                                    }}
                                    style={{
                                      padding: 11,
                                      borderRadius: 10,
                                      backgroundColor: theme.colors.surface0,
                                      borderWidth: 1,
                                      borderColor: selected
                                        ? theme.colors.accent
                                        : theme.colors.border,
                                      gap: 7,
                                    }}
                                  >
                                    <View
                                      style={{
                                        flexDirection: "row",
                                        alignItems: "center",
                                        justifyContent: "space-between",
                                      }}
                                    >
                                      <View
                                        style={{
                                          flexDirection: "row",
                                          alignItems: "center",
                                          gap: 6,
                                        }}
                                      >
                                        {proj ? (
                                          <ProjectDot
                                            color={proj.color}
                                            size={7}
                                          />
                                        ) : null}
                                        <Text
                                          style={{
                                            color: theme.colors.foregroundMuted,
                                            fontSize: 11,
                                            fontWeight: "700",
                                          }}
                                        >
                                          {task.key}
                                        </Text>
                                        <PriorityIcon
                                          priority={task.priority}
                                          theme={theme}
                                          size={12}
                                        />
                                        {!groupByStage && task.stage ? (
                                          <Text
                                            numberOfLines={1}
                                            style={{
                                              color: theme.colors.foregroundMuted,
                                              fontSize: 11,
                                            }}
                                          >
                                            {task.stage}
                                          </Text>
                                        ) : null}
                                      </View>

                                      <View
                                        style={{
                                          flexDirection: "row",
                                          alignItems: "center",
                                          gap: 2,
                                        }}
                                      >
                                        {groupByStage ? (
                                          <MenuButton
                                            accessibilityLabel={`Change stage of ${task.key}`}
                                            items={() => stageMenuItems(task)}
                                            style={cardMenuStyle}
                                          >
                                            <Icon
                                              name="Layers"
                                              size={12}
                                              color={theme.colors.foregroundMuted}
                                            />
                                          </MenuButton>
                                        ) : null}
                                        <MenuButton
                                          accessibilityLabel={`Change status of ${task.key}, ${STATUS_LABELS[task.status]}`}
                                          items={() => statusMenuItems(task)}
                                          style={cardMenuStyle}
                                        >
                                          <StatusIcon
                                            status={task.status}
                                            theme={theme}
                                            size={13}
                                          />
                                          <Icon
                                            name="ChevronDown"
                                            size={10}
                                            color={theme.colors.foregroundMuted}
                                          />
                                        </MenuButton>
                                      </View>
                                    </View>

                                    <Text
                                      numberOfLines={2}
                                      style={{
                                        color: theme.colors.foreground,
                                        fontSize: 13,
                                        fontWeight: "600",
                                        lineHeight: 18,
                                      }}
                                    >
                                      {task.title}
                                    </Text>

                                    <AgentLine task={task} theme={theme} />

                                    {taskLabels.length > 0 || task.dueDate ? (
                                      <View
                                        style={{
                                          flexDirection: "row",
                                          flexWrap: "wrap",
                                          alignItems: "center",
                                          gap: 5,
                                        }}
                                      >
                                        {taskLabels.map((l) => (
                                          <LabelPill
                                            key={l.id}
                                            name={l.name}
                                            color={l.color}
                                            theme={theme}
                                          />
                                        ))}
                                        {task.dueDate ? (
                                          <View
                                            style={{
                                              flexDirection: "row",
                                              alignItems: "center",
                                              gap: 4,
                                              paddingHorizontal: 6,
                                              paddingVertical: 2,
                                              borderRadius: 6,
                                              backgroundColor:
                                                theme.colors.surface2,
                                            }}
                                          >
                                            <Icon
                                              name="Calendar"
                                              size={10}
                                              color={theme.colors.foregroundMuted}
                                            />
                                            <Text
                                              style={{
                                                color:
                                                  theme.colors.foregroundMuted,
                                                fontSize: 10,
                                              }}
                                            >
                                              {task.dueDate}
                                            </Text>
                                          </View>
                                        ) : null}
                                      </View>
                                    ) : null}
                                  </Pressable>
                                </DraggableCard>
                              </React.Fragment>
                            );
                          })}
                          {dropLineAt !== null &&
                          dropLineAt >= otherTasks.length ? (
                            <DropLine theme={theme} />
                          ) : null}
                        </ScrollView>
                      </View>
                    );
                  })}
                </ScrollView>
              ) : (
                /* Grouped List View */
                <ScrollView
                  style={{ flex: 1 }}
                  contentContainerStyle={{
                    padding: compact ? 12 : 18,
                    gap: 14,
                  }}
                >
                  {listGroups.map((group) => {
                    const { status } = group;
                    const groupTasks = group.tasks;
                    const collapsed = collapsedStatuses.has(group.key);
                    return (
                      <View
                        key={group.key}
                        style={{
                          borderRadius: 10,
                          borderWidth: 1,
                          borderColor: theme.colors.border,
                          backgroundColor: theme.colors.surface1,
                          overflow: "hidden",
                        }}
                      >
                        <Pressable
                          accessibilityRole="button"
                          onPress={() =>
                            setCollapsedStatuses((prev) => {
                              const next = new Set(prev);
                              if (next.has(group.key)) next.delete(group.key);
                              else next.add(group.key);
                              return next;
                            })
                          }
                          style={{
                            flexDirection: "row",
                            alignItems: "center",
                            justifyContent: "space-between",
                            paddingHorizontal: 12,
                            paddingVertical: 9,
                            backgroundColor: theme.colors.surface2,
                          }}
                        >
                          <View
                            style={{
                              flexDirection: "row",
                              alignItems: "center",
                              gap: 8,
                            }}
                          >
                            <StatusIcon
                              status={status}
                              theme={theme}
                              size={14}
                            />
                            <Text
                              style={{
                                color: theme.colors.foreground,
                                fontSize: 13,
                                fontWeight: "700",
                              }}
                            >
                              {group.label}
                            </Text>
                            <Text
                              style={{
                                color: theme.colors.foregroundMuted,
                                fontSize: 12,
                              }}
                            >
                              {groupTasks.length}
                            </Text>
                          </View>
                          {group.canAdd ? (
                          <Pressable
                            accessibilityRole="button"
                            onPress={() => {
                              setNewTaskDefaultStatus(status);
                              setNewTaskOpen(true);
                            }}
                            style={{
                              paddingHorizontal: 7,
                              paddingVertical: 3,
                              borderRadius: 6,
                              backgroundColor: theme.colors.surface1,
                            }}
                          >
                            <Text
                              style={{
                                color: theme.colors.foreground,
                                fontSize: 11,
                              }}
                            >
                              + Add
                            </Text>
                          </Pressable>
                          ) : null}
                        </Pressable>

                        {!collapsed ? (
                          <View>
                            {groupTasks.length === 0 ? (
                              <Text
                                style={{
                                  padding: 12,
                                  color: theme.colors.foregroundMuted,
                                  fontSize: 12,
                                }}
                              >
                                {group.key === "idea"
                                  ? "No ideas yet. Agents propose follow-ups they find here."
                                  : `No tasks in ${group.label}.`}
                              </Text>
                            ) : (
                              groupTasks.map((task) => {
                                const selected = selectedTaskKey === task.key;
                                const taskLabels = task.labelIds
                                  .map((id) => labelById.get(id))
                                  .filter((l): l is Label => Boolean(l));
                                return (
                                  <Pressable
                                    key={task.id}
                                    accessibilityRole="button"
                                    onPress={() =>
                                      setSelectedTaskKey(task.key)
                                    }
                                    style={{
                                      flexDirection: "row",
                                      alignItems: "center",
                                      gap: 10,
                                      paddingHorizontal: 12,
                                      paddingVertical: 10,
                                      borderTopWidth: 1,
                                      borderTopColor: theme.colors.border,
                                      backgroundColor: selected
                                        ? theme.colors.surface2
                                        : theme.colors.surface0,
                                    }}
                                  >
                                    <PriorityIcon
                                      priority={task.priority}
                                      theme={theme}
                                      size={13}
                                    />
                                    <Text
                                      style={{
                                        color: theme.colors.foregroundMuted,
                                        fontSize: 12,
                                        fontWeight: "700",
                                        width: 72,
                                      }}
                                    >
                                      {task.key}
                                    </Text>
                                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                                      <Text
                                        numberOfLines={1}
                                        style={{
                                          color: theme.colors.foreground,
                                          fontSize: 13,
                                          fontWeight: "600",
                                        }}
                                      >
                                        {task.title}
                                      </Text>
                                      <AgentLine task={task} theme={theme} />
                                    </View>
                                    <View
                                      style={{
                                        flexDirection: "row",
                                        alignItems: "center",
                                        gap: 6,
                                      }}
                                    >
                                      {taskLabels.slice(0, 2).map((l) => (
                                        <LabelPill
                                          key={l.id}
                                          name={l.name}
                                          color={l.color}
                                          theme={theme}
                                        />
                                      ))}
                                      {task.dueDate ? (
                                        <Text
                                          style={{
                                            color:
                                              theme.colors.foregroundMuted,
                                            fontSize: 11,
                                          }}
                                        >
                                          {task.dueDate}
                                        </Text>
                                      ) : null}
                                    </View>
                                  </Pressable>
                                );
                              })
                            )}
                          </View>
                        ) : null}
                      </View>
                    );
                  })}
                </ScrollView>
              )}
            </View>

            {/* Right Split Task Detail Pane (Wide Desktop) */}
            {!compact && selectedTaskKey ? (
              <View
                style={{
                  width: 420,
                  borderLeftWidth: 1,
                  borderLeftColor: theme.colors.border,
                  backgroundColor: theme.colors.surface0,
                }}
              >
                <TaskDetailView
                  taskKey={selectedTaskKey}
                  theme={theme}
                  compact={false}
                  onSelectTaskKey={setSelectedTaskKey}
                  onClose={() => setSelectedTaskKey(null)}
                  onOpenManagePresets={() => {
                    setManageTab("presets");
                    setManageOpen(true);
                  }}
                  openAgent={openAgent}
                  openWorkspace={openWorkspace}
                />
              </View>
            ) : null}
          </View>
        )}
      </View>

      <NewTaskModal
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        defaultProjectId={selectedProjectId ?? projects[0]?.id ?? null}
        defaultStatus={newTaskDefaultStatus}
        theme={theme}
        onCreated={(taskKey) => setSelectedTaskKey(taskKey)}
      />

      <ManageModal
        open={manageOpen}
        onOpenChange={setManageOpen}
        initialTab={manageTab}
        theme={theme}
      />
      {drag ? (
        <DragGhost
          task={tasks.find((t) => t.id === drag.taskId)}
          left={drag.point.x - geometry.current.origin.x + 8}
          top={drag.point.y - geometry.current.origin.y + 8}
          theme={theme}
        />
      ) : null}
      {lastMove ? (
        <View
          key={lastMove.id}
          style={{
            position: "absolute",
            bottom: 16,
            alignSelf: "center",
            left: 0,
            right: 0,
            alignItems: "center",
          }}
          pointerEvents="box-none"
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              paddingLeft: 14,
              paddingRight: 6,
              paddingVertical: 6,
              borderRadius: 8,
              backgroundColor: theme.colors.surface2,
              borderWidth: 1,
              borderColor: theme.colors.border,
            }}
          >
            <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
              {lastMove.message}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => void handleUndoMove()}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 5,
                borderRadius: 6,
                backgroundColor: theme.colors.surface0,
              }}
            >
              <Text
                style={{
                  color: theme.colors.foreground,
                  fontSize: 13,
                  fontWeight: "600",
                }}
              >
                Undo
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function QuickCreate({
  theme,
  placeholder,
  onSubmit,
}: {
  theme: PluginTheme;
  placeholder: string;
  onSubmit: (title: string) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  async function submit() {
    const trimmed = title.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    if (await onSubmit(trimmed)) setTitle("");
    setSubmitting(false);
  }
  return (
    <TextInput
      value={title}
      onChangeText={setTitle}
      onSubmitEditing={() => void submit()}
      submitBehavior="submit"
      editable={!submitting}
      placeholder={placeholder}
      placeholderTextColor={theme.colors.foregroundMuted}
      accessibilityLabel={placeholder}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
        color: theme.colors.foreground,
        fontSize: 12,
      }}
    />
  );
}

function DragGhost({
  task,
  left,
  top,
  theme,
}: {
  task: Task | undefined;
  left: number;
  top: number;
  theme: PluginTheme;
}) {
  if (!task) return null;
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left,
        top,
        width: 240,
        padding: 10,
        gap: 4,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
        shadowColor: "#000",
        shadowOpacity: 0.18,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 8 },
        zIndex: 50,
      }}
    >
      <Text
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 11,
          fontWeight: "700",
        }}
      >
        {task.key}
      </Text>
      <Text
        numberOfLines={2}
        style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}
      >
        {task.title}
      </Text>
    </View>
  );
}

export function TasksScreen({
  theme,
  layout,
  params,
  navigation,
}: PluginScreenProps) {
  return (
    <MenuProvider theme={theme}>
      <TasksBoardAndListShell
        theme={theme}
        compact={layout.compact}
        initialTaskKey={params.taskKey ?? null}
        initialProjectId={params.projectId ?? null}
        openAgent={navigation?.openAgent}
        openWorkspace={navigation?.openWorkspace}
      />
    </MenuProvider>
  );
}

export function TasksWorkspacePanel({
  theme,
  layout,
  workspaceId,
  navigation,
}: PluginWorkspacePanelProps) {
  const ws = useWorkspace(workspaceId, (w) => ({
    projectId: w.projectId,
  }));

  return (
    <MenuProvider theme={theme}>
      <TasksBoardAndListShell
        theme={theme}
        compact={layout.compact}
        linkedPaseoProjectId={ws?.projectId ?? null}
        openAgent={navigation?.openAgent}
        openWorkspace={navigation?.openWorkspace}
      />
    </MenuProvider>
  );
}

export function TaskAgentPanel({
  theme,
  layout,
  workspaceId,
  agentId,
  navigation,
}: PluginAgentPanelProps) {
  const getAgentTasks = useRpc(getAgentTasksRpc);
  const ws = useWorkspace(workspaceId, (w) => ({
    projectId: w.projectId,
  }));
  const agent = useAgent(agentId, (a) => ({
    id: a.id,
    title: a.title,
    labels: a.labels,
  }));

  const agentTasksQuery = useQuery({
    queryKey: ["tasks", "agentTasks", agentId],
    queryFn: () => getAgentTasks({ agentId }),
    refetchInterval: 3000,
  });

  const labelTaskKey = agent?.labels?.taskKey ?? null;
  const attachedTasks = agentTasksQuery.data?.tasks ?? [];
  const defaultTaskKey = labelTaskKey ?? attachedTasks[0]?.key ?? null;

  const [selectedTaskKey, setSelectedTaskKey] = useState<string | null>(
    defaultTaskKey,
  );

  useEffect(() => {
    if (!selectedTaskKey && defaultTaskKey) {
      setSelectedTaskKey(defaultTaskKey);
    }
  }, [defaultTaskKey, selectedTaskKey]);

  if (selectedTaskKey) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
        {attachedTasks.length > 1 ? (
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 6,
              padding: 10,
              borderBottomWidth: 1,
              borderBottomColor: theme.colors.border,
              backgroundColor: theme.colors.surface1,
            }}
          >
            {attachedTasks.map((t) => (
              <Pressable
                key={t.id}
                accessibilityRole="button"
                onPress={() => setSelectedTaskKey(t.key)}
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  borderRadius: 6,
                  backgroundColor:
                    selectedTaskKey === t.key
                      ? theme.colors.accent
                      : theme.colors.surface2,
                }}
              >
                <Text
                  style={{
                    color:
                      selectedTaskKey === t.key
                        ? theme.colors.accentForeground
                        : theme.colors.foreground,
                    fontSize: 11,
                    fontWeight: "600",
                  }}
                >
                  {t.key}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <MenuProvider theme={theme}>
          <TaskDetailView
            taskKey={selectedTaskKey}
            theme={theme}
            compact={layout.compact}
            onSelectTaskKey={setSelectedTaskKey}
            onClose={() => setSelectedTaskKey(null)}
            openAgent={navigation?.openAgent}
            openWorkspace={navigation?.openWorkspace}
          />
        </MenuProvider>
      </View>
    );
  }

  return (
    <MenuProvider theme={theme}>
      <TasksBoardAndListShell
        theme={theme}
        compact={layout.compact}
        linkedPaseoProjectId={ws?.projectId ?? null}
        openAgent={navigation?.openAgent}
        openWorkspace={navigation?.openWorkspace}
      />
    </MenuProvider>
  );
}

export function TasksSidebarItem({
  theme,
  currentScreen,
  openScreen,
}: PluginSidebarItemProps) {
  const sidebarOpenTaskCount = useRpc(sidebarOpenTaskCountRpc);
  const countQuery = useQuery({
    queryKey: ["tasks", "openCount"],
    queryFn: () => sidebarOpenTaskCount({}),
    refetchInterval: 5000,
  });

  const openCount = countQuery.data?.openTaskCount ?? 0;

  return (
    <SidebarRow
      icon="ListTodo"
      label="Tasks"
      active={currentScreen?.screenId === "main"}
      onPress={() => openScreen({ screenId: "main" })}
      trailing={
        openCount > 0 ? (
          <View
            style={{
              paddingHorizontal: 6,
              paddingVertical: 1,
              borderRadius: 999,
              backgroundColor: theme.colors.surface2,
            }}
          >
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 11,
                fontWeight: "600",
              }}
            >
              {openCount}
            </Text>
          </View>
        ) : undefined
      }
    />
  );
}
