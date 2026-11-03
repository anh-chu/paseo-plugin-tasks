import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import {
  copyText,
  Icon,
  TextInput,
  useToast,
} from "@getpaseo/plugin/client/react-native";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  attachmentGetCommand,
  PRIORITY_LABELS,
  STATUS_LABELS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  UNSORTED_PREFIX,
  type TaskPriority,
  type TaskStatus,
} from "../shared/constants";
import {
  attachTaskThreadRpc,
  createCommentRpc,
  createTaskRpc,
  delegateTaskRpc,
  deleteAttachmentRpc,
  deleteTaskRpc,
  detachTaskThreadRpc,
  getTaskByKeyRpc,
  listAttachmentsRpc,
  listCommentsRpc,
  listLabelsRpc,
  listPresetsRpc,
  listProjectsRpc,
  listTaskPullRequestsRpc,
  listTasksRpc,
  listTaskThreadsRpc,
  moveTaskToProjectRpc,
  searchThreadsRpc,
  updateProjectRpc,
  updateTaskRpc,
  uploadAttachmentRpc,
  type Project,
  type Task,
} from "../shared/contract";
import {
  formatRelativeTime,
  LabelPill,
  PriorityBadge,
  PriorityIcon,
  ProjectDot,
  StatusBadge,
  StatusIcon,
  ThreadLiveStatusBadge,
} from "./badges";
import { MenuButton } from "./menu";

export interface TaskDetailViewProps {
  taskKey: string;
  theme: PluginTheme;
  compact: boolean;
  onSelectTaskKey?: (taskKey: string) => void;
  onClose?: () => void;
  onOpenManagePresets?: () => void;
  openAgent?: (input: { readonly agentId: string }) => void;
  openWorkspace?: (input: { readonly workspaceId: string }) => void;
}

export function TaskDetailView({
  taskKey,
  theme,
  compact,
  onSelectTaskKey,
  onClose,
  onOpenManagePresets,
  openAgent,
  openWorkspace,
}: TaskDetailViewProps) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const getTaskByKey = useRpc(getTaskByKeyRpc);
  const updateTask = useRpc(updateTaskRpc);
  const deleteTask = useRpc(deleteTaskRpc);
  const moveTaskToProject = useRpc(moveTaskToProjectRpc);
  const createTask = useRpc(createTaskRpc);
  const listTasks = useRpc(listTasksRpc);
  const listProjects = useRpc(listProjectsRpc);
  const listLabels = useRpc(listLabelsRpc);
  const listComments = useRpc(listCommentsRpc);
  const createComment = useRpc(createCommentRpc);
  const listAttachments = useRpc(listAttachmentsRpc);
  const uploadAttachment = useRpc(uploadAttachmentRpc);
  const deleteAttachment = useRpc(deleteAttachmentRpc);
  const listTaskThreads = useRpc(listTaskThreadsRpc);
  const listTaskPullRequests = useRpc(listTaskPullRequestsRpc);
  const listPresets = useRpc(listPresetsRpc);
  const delegateTask = useRpc(delegateTaskRpc);
  const attachTaskThread = useRpc(attachTaskThreadRpc);
  const detachTaskThread = useRpc(detachTaskThreadRpc);
  const searchThreads = useRpc(searchThreadsRpc);

  const taskQuery = useQuery({
    queryKey: ["tasks", "detail", taskKey],
    queryFn: () => getTaskByKey({ taskKey }),
    refetchInterval: 3000,
  });

  const task = taskQuery.data?.task ?? null;

  const projectsQuery = useQuery({
    queryKey: ["tasks", "projects"],
    queryFn: () => listProjects({}),
  });

  const labelsQuery = useQuery({
    queryKey: ["tasks", "labels", task?.projectId],
    queryFn: () => listLabels({ projectId: task!.projectId }),
    enabled: Boolean(task?.projectId),
  });

  const subtasksQuery = useQuery({
    queryKey: ["tasks", "subtasks", task?.id],
    queryFn: () => listTasks({ parentTaskId: task!.id, limit: 200 }),
    enabled: Boolean(task?.id),
    refetchInterval: 4000,
  });

  const commentsQuery = useQuery({
    queryKey: ["tasks", "comments", task?.id],
    queryFn: () => listComments({ taskId: task!.id }),
    enabled: Boolean(task?.id),
    refetchInterval: 3000,
  });

  const attachmentsQuery = useQuery({
    queryKey: ["tasks", "attachments", task?.id],
    queryFn: async () => {
      const [direct, fromComments] = await Promise.all([
        listAttachments({ taskId: task!.id }),
        listAttachments({ commentsOfTaskId: task!.id }),
      ]);
      return [...direct.attachments, ...fromComments.attachments];
    },
    enabled: Boolean(task?.id),
    refetchInterval: 5000,
  });

  const threadsQuery = useQuery({
    queryKey: ["tasks", "threads", task?.id],
    queryFn: () => listTaskThreads({ taskId: task!.id }),
    enabled: Boolean(task?.id),
    refetchInterval: 3000,
  });

  const pullRequestsQuery = useQuery({
    queryKey: ["tasks", "prs", task?.id],
    queryFn: () => listTaskPullRequests({ taskId: task!.id }),
    enabled: Boolean(task?.id),
    refetchInterval: 10000,
  });

  const presetsQuery = useQuery({
    queryKey: ["tasks", "presets"],
    queryFn: () => listPresets({}),
  });

  const [editingHeader, setEditingHeader] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [dueDraft, setDueDraft] = useState("");

  const [newSubtaskTitle, setNewSubtaskTitle] = useState("");
  const [commentDraft, setCommentDraft] = useState("");
  const [notifyAgent, setNotifyAgent] = useState(true);
  const [postingComment, setPostingComment] = useState(false);

  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [extraInstructions, setExtraInstructions] = useState("");
  const [delegating, setDelegating] = useState(false);

  const [showAttachAgent, setShowAttachAgent] = useState(false);
  const [agentSearchQuery, setAgentSearchQuery] = useState("");

  const [showNewNoteAttachment, setShowNewNoteAttachment] = useState(false);
  const [noteFileName, setNoteFileName] = useState("notes.md");
  const [noteContent, setNoteContent] = useState("");

  const searchThreadsQuery = useQuery({
    queryKey: ["tasks", "searchThreads", agentSearchQuery],
    queryFn: () => searchThreads({ query: agentSearchQuery, limit: 8 }),
    enabled: showAttachAgent,
  });

  useEffect(() => {
    if (task && !editingHeader) {
      setTitleDraft(task.title);
      setDescriptionDraft(task.description);
      setDueDraft(task.dueDate ?? "");
    }
  }, [task, editingHeader]);

  const presets = presetsQuery.data?.presets ?? [];
  useEffect(() => {
    if (!selectedPresetId && presets.length > 0) {
      setSelectedPresetId(presets[0]!.id);
    }
  }, [presets, selectedPresetId]);

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
  };

  if (taskQuery.isLoading) {
    return (
      <View
        style={{
          flex: 1,
          padding: 20,
          backgroundColor: theme.colors.surface0,
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <Text style={{ color: theme.colors.foregroundMuted }}>
          Loading {taskKey}…
        </Text>
      </View>
    );
  }

  if (!task) {
    return (
      <View
        style={{
          flex: 1,
          padding: 20,
          backgroundColor: theme.colors.surface0,
          gap: 12,
        }}
      >
        <Text style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "600" }}>
          Task {taskKey} not found
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
          It may have been deleted or moved to another project prefix.
        </Text>
        {onClose ? (
          <Pressable
            accessibilityRole="button"
            onPress={onClose}
            style={{
              alignSelf: "flex-start",
              paddingHorizontal: 12,
              paddingVertical: 7,
              borderRadius: 8,
              backgroundColor: theme.colors.surface2,
            }}
          >
            <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
              Close
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  const projects = projectsQuery.data?.projects ?? [];
  const inUnsorted =
    projects.find((p) => p.id === task?.projectId)?.prefix === UNSORTED_PREFIX;
  const currentProject = projects.find((p) => p.id === task.projectId);
  const projectLabels = labelsQuery.data?.labels ?? [];
  const subtasks = subtasksQuery.data?.tasks ?? [];
  const comments = commentsQuery.data?.comments ?? [];
  const attachments = attachmentsQuery.data ?? [];
  const taskThreads = threadsQuery.data?.taskThreads ?? [];
  const pullRequests = pullRequestsQuery.data?.pullRequests ?? [];

  const latestAgentComment = [...comments]
    .reverse()
    .find((c) => c.kind === "agent" && c.threadId);
  const notifyTargetThreadId =
    latestAgentComment?.threadId ?? taskThreads[0]?.threadId ?? null;
  const notifyTargetLabel =
    latestAgentComment?.threadTitle ??
    latestAgentComment?.authorName ??
    taskThreads[0]?.title ??
    notifyTargetThreadId;

  const propertyStyle = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 7,
    backgroundColor: theme.colors.surface2,
  };
  const propertyTextStyle = {
    color: theme.colors.foreground,
    fontSize: 12,
    fontWeight: "600" as const,
  };

  async function handleQuickUpdate(
    patch: Partial<{
      status: TaskStatus;
      stage: string | null;
      idea: false;
      priority: TaskPriority;
      dueDate: string | null;
      labelIds: string[];
      title: string;
      description: string;
    }>,
  ) {
    if (!task) return;
    try {
      const res = await updateTask({
        taskId: task.id,
        ...patch,
        authorName: "You",
      });
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      invalidateAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleSaveHeader() {
    if (!task) return;
    const trimmedDue = dueDraft.trim();
    await handleQuickUpdate({
      title: titleDraft.trim() || task.title,
      description: descriptionDraft,
      dueDate: trimmedDue === "" ? null : trimmedDue,
    });
    setEditingHeader(false);
    toast.show("Task saved", { variant: "success" });
  }

  async function handleToggleLabel(labelId: string) {
    if (!task) return;
    const has = task.labelIds.includes(labelId);
    const next = has
      ? task.labelIds.filter((id) => id !== labelId)
      : [...task.labelIds, labelId];
    await handleQuickUpdate({ labelIds: next });
  }

  async function handleCreateSubtask() {
    if (!task || !newSubtaskTitle.trim()) return;
    try {
      const res = await createTask({
        projectId: task.projectId,
        title: newSubtaskTitle.trim(),
        status: "todo",
        priority: "none",
        parentTaskId: task.id,
      });
      if (!res.ok) {
        toast.error(res.error.message);
        return;
      }
      setNewSubtaskTitle("");
      invalidateAll();
      toast.show(`Created subtask ${res.task.key}`, { variant: "success" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleDelegate() {
    if (!task || !selectedPresetId) return;
    setDelegating(true);
    try {
      const res = await delegateTask({
        taskId: task.id,
        presetId: selectedPresetId,
        ...(extraInstructions.trim()
          ? { extraInstructions: extraInstructions.trim() }
          : {}),
      });
      setExtraInstructions("");
      invalidateAll();
      toast.show(`Dispatched ${task.key} to agent`, { variant: "success" });
      if (openAgent) {
        openAgent({ agentId: res.threadId });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setDelegating(false);
    }
  }

  async function handlePostComment() {
    if (!task || !commentDraft.trim()) return;
    setPostingComment(true);
    try {
      await createComment({
        taskId: task.id,
        body: commentDraft.trim(),
        notify: Boolean(notifyTargetThreadId && notifyAgent),
      });
      setCommentDraft("");
      invalidateAll();
      toast.show(
        notifyTargetThreadId && notifyAgent
          ? "Comment posted & agent notified"
          : "Comment posted",
        { variant: "success" },
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setPostingComment(false);
    }
  }

  async function handleAddNoteAttachment() {
    if (!task || !noteContent.trim()) return;
    try {
      const bytes = Array.from(new TextEncoder().encode(noteContent));
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      // Simple base64 encoding without DOM globals
      const chars =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      let base64 = "";
      for (let i = 0; i < bytes.length; i += 3) {
        const b1 = bytes[i] ?? 0;
        const b2 = bytes[i + 1] ?? 0;
        const b3 = bytes[i + 2] ?? 0;
        const triplet = (b1 << 16) | (b2 << 8) | b3;
        base64 += chars[(triplet >> 18) & 0x3f];
        base64 += chars[(triplet >> 12) & 0x3f];
        base64 += i + 1 < bytes.length ? chars[(triplet >> 6) & 0x3f] : "=";
        base64 += i + 2 < bytes.length ? chars[triplet & 0x3f] : "=";
      }
      await uploadAttachment({
        taskId: task.id,
        fileName: noteFileName.trim() || "notes.md",
        mime: "text/markdown",
        base64,
      });
      setNoteContent("");
      setShowNewNoteAttachment(false);
      invalidateAll();
      toast.show("Attachment added", { variant: "success" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{
        padding: compact ? 14 : 20,
        gap: 16,
      }}
    >
      {/* Top Action Bar */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {currentProject ? <ProjectDot color={currentProject.color} size={10} /> : null}
          <Text
            selectable
            style={{
              color: theme.colors.foreground,
              fontSize: 13,
              fontWeight: "700",
            }}
          >
            {task.key}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Copy task key ${task.key}`}
            onPress={async () => {
              try {
                await copyText(task.key);
                toast.show(`Copied ${task.key}`, { variant: "success" });
              } catch {}
            }}
            style={{
              paddingHorizontal: 6,
              paddingVertical: 3,
              borderRadius: 6,
              backgroundColor: theme.colors.surface2,
            }}
          >
            <Icon name="Copy" size={12} color={theme.colors.foregroundMuted} />
          </Pressable>
          {task.parentTaskId ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              Sub-task
            </Text>
          ) : null}
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {task.idea ? (
            <>
              {inUnsorted ? null : <Pressable
                accessibilityRole="button"
                onPress={() => void handleQuickUpdate({ idea: false })}
                style={{
                  paddingHorizontal: 9,
                  paddingVertical: 5,
                  borderRadius: 7,
                  backgroundColor: theme.colors.accent,
                }}
              >
                <Text style={{ color: theme.colors.accentForeground, fontSize: 12, fontWeight: "600" }}>
                  Accept idea
                </Text>
              </Pressable>}
              <Pressable
                accessibilityRole="button"
                onPress={() =>
                  void handleQuickUpdate({ idea: false, status: "canceled" })
                }
                style={{
                  paddingHorizontal: 9,
                  paddingVertical: 5,
                  borderRadius: 7,
                  backgroundColor: theme.colors.surface2,
                }}
              >
                <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "500" }}>
                  Dismiss
                </Text>
              </Pressable>
            </>
          ) : null}
          <Pressable
            accessibilityRole="button"
            onPress={() => setEditingHeader((prev) => !prev)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 5,
              paddingHorizontal: 9,
              paddingVertical: 5,
              borderRadius: 7,
              backgroundColor: theme.colors.surface2,
            }}
          >
            <Icon name="Pencil" size={12} color={theme.colors.foreground} />
            <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "500" }}>
              {editingHeader ? "Cancel" : "Edit"}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Delete ${task.key}`}
            onPress={async () => {
              try {
                await deleteTask({ taskId: task.id });
                invalidateAll();
                toast.show(`Deleted ${task.key}`, { variant: "info" });
                onClose?.();
              } catch (error) {
                toast.error(
                  error instanceof Error ? error.message : String(error),
                );
              }
            }}
            style={{
              paddingHorizontal: 8,
              paddingVertical: 5,
              borderRadius: 7,
              backgroundColor: theme.colors.surface2,
            }}
          >
            <Icon name="Trash2" size={13} color={theme.colors.statusDanger} />
          </Pressable>
          {onClose ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close task details"
              onPress={onClose}
              style={{
                paddingHorizontal: 8,
                paddingVertical: 5,
                borderRadius: 7,
                backgroundColor: theme.colors.surface2,
              }}
            >
              <Icon name="X" size={14} color={theme.colors.foreground} />
            </Pressable>
          ) : null}
        </View>
      </View>

      {task.idea && inUnsorted ? (
        <AcceptIntoProject
          theme={theme}
          task={task}
          projects={projects.filter((p) => p.prefix !== UNSORTED_PREFIX)}
          onAccepted={(key) => {
            invalidateAll();
            onSelectTaskKey?.(key);
          }}
        />
      ) : null}

      {/* Title & Description */}
      {editingHeader ? (
        <View
          style={{
            padding: 12,
            borderRadius: 10,
            backgroundColor: theme.colors.surface1,
            borderWidth: 1,
            borderColor: theme.colors.border,
            gap: 10,
          }}
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>
            TITLE
          </Text>
          <TextInput
            value={titleDraft}
            onChangeText={setTitleDraft}
            placeholder="Task title"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={{
              paddingHorizontal: 10,
              paddingVertical: 8,
              borderRadius: 8,
              backgroundColor: theme.colors.surface2,
              color: theme.colors.foreground,
              fontSize: 15,
              fontWeight: "600",
            }}
          />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>
            DESCRIPTION (MARKDOWN)
          </Text>
          <TextInput
            value={descriptionDraft}
            onChangeText={setDescriptionDraft}
            multiline
            placeholder="Describe context, acceptance criteria, and links…"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={{
              minHeight: 96,
              paddingHorizontal: 10,
              paddingVertical: 8,
              borderRadius: 8,
              backgroundColor: theme.colors.surface2,
              color: theme.colors.foreground,
              fontSize: 13,
              textAlignVertical: "top",
            }}
          />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>
            DUE DATE (YYYY-MM-DD)
          </Text>
          <TextInput
            value={dueDraft}
            onChangeText={setDueDraft}
            placeholder="2026-10-25"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={{
              paddingHorizontal: 10,
              paddingVertical: 7,
              borderRadius: 8,
              backgroundColor: theme.colors.surface2,
              color: theme.colors.foreground,
              fontSize: 13,
            }}
          />
          <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setEditingHeader(false)}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 7,
                borderRadius: 8,
                backgroundColor: theme.colors.surface2,
              }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
                Cancel
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={handleSaveHeader}
              style={{
                paddingHorizontal: 14,
                paddingVertical: 7,
                borderRadius: 8,
                backgroundColor: theme.colors.accent,
              }}
            >
              <Text
                style={{
                  color: theme.colors.accentForeground,
                  fontSize: 13,
                  fontWeight: "600",
                }}
              >
                Save Changes
              </Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={{ gap: 8 }}>
          <Text
            selectable
            style={{
              color: theme.colors.foreground,
              fontSize: compact ? 18 : 20,
              fontWeight: "700",
              lineHeight: 26,
            }}
          >
            {task.title}
          </Text>
          <View
            style={{
              padding: 12,
              borderRadius: 10,
              backgroundColor: theme.colors.surface1,
              borderWidth: 1,
              borderColor: theme.colors.border,
            }}
          >
            <Text
              selectable
              style={{
                color: task.description.trim()
                  ? theme.colors.foreground
                  : theme.colors.foregroundMuted,
                fontSize: 13,
                lineHeight: 20,
              }}
            >
              {task.description.trim() || "No description provided. Press Edit to add one."}
            </Text>
          </View>
        </View>
      )}

      {/* Properties Rail: Status, Priority, Stage, Labels, Project */}
      <View
        style={{
          padding: 12,
          borderRadius: 10,
          backgroundColor: theme.colors.surface1,
          borderWidth: 1,
          borderColor: theme.colors.border,
          gap: 12,
        }}
      >
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          <MenuButton
            accessibilityLabel={`Status, ${STATUS_LABELS[task.status]}`}
            items={() =>
              TASK_STATUSES.map((status) => ({
                key: status,
                label: STATUS_LABELS[status],
                icon: <StatusIcon status={status} theme={theme} size={12} />,
                selected: task.status === status,
                onSelect: () => {
                  if (status !== task.status) void handleQuickUpdate({ status });
                },
              }))
            }
            style={propertyStyle}
          >
            <StatusIcon status={task.status} theme={theme} size={12} />
            <Text style={propertyTextStyle}>{STATUS_LABELS[task.status]}</Text>
            <Icon name="ChevronDown" size={11} color={theme.colors.foregroundMuted} />
          </MenuButton>

          <MenuButton
            accessibilityLabel={`Priority, ${PRIORITY_LABELS[task.priority]}`}
            items={() =>
              TASK_PRIORITIES.map((priority) => ({
                key: priority,
                label: PRIORITY_LABELS[priority],
                icon: <PriorityIcon priority={priority} theme={theme} size={12} />,
                selected: task.priority === priority,
                onSelect: () => {
                  if (priority !== task.priority) {
                    void handleQuickUpdate({ priority });
                  }
                },
              }))
            }
            style={propertyStyle}
          >
            <PriorityIcon priority={task.priority} theme={theme} size={12} />
            <Text style={propertyTextStyle}>{PRIORITY_LABELS[task.priority]}</Text>
            <Icon name="ChevronDown" size={11} color={theme.colors.foregroundMuted} />
          </MenuButton>

          {currentProject && currentProject.stages.length > 0 ? (
            <MenuButton
              accessibilityLabel={`Stage, ${task.stage ?? "None"}`}
              items={() =>
                [
                  null,
                  ...currentProject.stages,
                  ...(task.stage !== null && !currentProject.stages.includes(task.stage)
                    ? [task.stage]
                    : []),
                ].map((stage) => ({
                  key: stage ?? "",
                  label: stage ?? "No stage",
                  selected: task.stage === stage,
                  onSelect: () => {
                    if (task.stage !== stage) void handleQuickUpdate({ stage });
                  },
                }))
              }
              style={propertyStyle}
            >
              <Icon name="Layers" size={12} color={theme.colors.foregroundMuted} />
              <Text style={propertyTextStyle}>{task.stage ?? "No stage"}</Text>
              <Icon name="ChevronDown" size={11} color={theme.colors.foregroundMuted} />
            </MenuButton>
          ) : null}
        </View>

        {projectLabels.length > 0 ? (
          <View style={{ gap: 6 }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>
              LABELS
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {projectLabels.map((label) => {
                const selected = task.labelIds.includes(label.id);
                return (
                  <Pressable
                    key={label.id}
                    accessibilityRole="button"
                    onPress={() => void handleToggleLabel(label.id)}
                    style={{ opacity: selected ? 1 : 0.5 }}
                  >
                    <LabelPill name={label.name} color={label.color} theme={theme} />
                  </Pressable>
                );
              })}
            </View>
          </View>
        ) : null}

        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            Due: {task.dueDate ?? "None"}
          </Text>
          {projects.length > 1 ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                Move to:
              </Text>
              {projects
                .filter((p) => p.id !== task.projectId)
                .map((p) => (
                  <Pressable
                    key={p.id}
                    accessibilityRole="button"
                    onPress={async () => {
                      try {
                        const res = await moveTaskToProject({
                          taskId: task.id,
                          projectId: p.id,
                        });
                        if (!res.ok) {
                          toast.error(res.error.message);
                          return;
                        }
                        invalidateAll();
                        toast.show(`Moved to ${res.task.key}`, {
                          variant: "success",
                        });
                        onSelectTaskKey?.(res.task.key);
                      } catch (error) {
                        toast.error(
                          error instanceof Error ? error.message : String(error),
                        );
                      }
                    }}
                    style={{
                      paddingHorizontal: 7,
                      paddingVertical: 3,
                      borderRadius: 6,
                      backgroundColor: theme.colors.surface2,
                    }}
                  >
                    <Text style={{ color: theme.colors.foreground, fontSize: 11 }}>
                      {p.prefix}
                    </Text>
                  </Pressable>
                ))}
            </View>
          ) : null}
        </View>
      </View>

      {/* Delegate to Agent Card */}
      <View
        style={{
          padding: 12,
          borderRadius: 10,
          backgroundColor: theme.colors.surface1,
          borderWidth: 1,
          borderColor: theme.colors.border,
          gap: 10,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Icon name="Play" size={14} color={theme.colors.accent} />
            <Text
              style={{
                color: theme.colors.foreground,
                fontSize: 13,
                fontWeight: "700",
              }}
            >
              Delegate to Agent
            </Text>
          </View>
          {onOpenManagePresets ? (
            <Pressable
              accessibilityRole="button"
              onPress={onOpenManagePresets}
              style={{
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 6,
                backgroundColor: theme.colors.surface2,
              }}
            >
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                Manage Presets
              </Text>
            </Pressable>
          ) : null}
        </View>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {presets.map((preset) => {
            const active = preset.id === selectedPresetId;
            return (
              <Pressable
                key={preset.id}
                accessibilityRole="button"
                onPress={() => setSelectedPresetId(preset.id)}
                style={{
                  paddingHorizontal: 9,
                  paddingVertical: 5,
                  borderRadius: 7,
                  borderWidth: 1,
                  borderColor: active
                    ? theme.colors.accent
                    : theme.colors.border,
                  backgroundColor: active
                    ? theme.colors.accent
                    : theme.colors.surface2,
                }}
              >
                <Text
                  style={{
                    color: active
                      ? theme.colors.accentForeground
                      : theme.colors.foreground,
                    fontSize: 11,
                    fontWeight: active ? "700" : "500",
                  }}
                >
                  {preset.name}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <TextInput
          value={extraInstructions}
          onChangeText={setExtraInstructions}
          placeholder="Optional extra dispatch instructions…"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={{
            paddingHorizontal: 10,
            paddingVertical: 7,
            borderRadius: 8,
            backgroundColor: theme.colors.surface2,
            color: theme.colors.foreground,
            fontSize: 12,
          }}
        />

        <Pressable
          accessibilityRole="button"
          disabled={delegating || !selectedPresetId}
          onPress={() => void handleDelegate()}
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            paddingVertical: 9,
            borderRadius: 8,
            backgroundColor: theme.colors.accent,
            opacity: delegating || !selectedPresetId ? 0.6 : 1,
          }}
        >
          <Icon name="Play" size={13} color={theme.colors.accentForeground} />
          <Text
            style={{
              color: theme.colors.accentForeground,
              fontSize: 13,
              fontWeight: "700",
            }}
          >
            {delegating ? "Dispatching Worker Agent…" : "Dispatch Worker Agent"}
          </Text>
        </Pressable>
      </View>

      {/* Sub-tasks Card */}
      {task.parentTaskId === null ? (
        <View
          style={{
            padding: 12,
            borderRadius: 10,
            backgroundColor: theme.colors.surface1,
            borderWidth: 1,
            borderColor: theme.colors.border,
            gap: 10,
          }}
        >
          <Text
            style={{
              color: theme.colors.foreground,
              fontSize: 13,
              fontWeight: "700",
            }}
          >
            Sub-tasks ({subtasks.length})
          </Text>

          {subtasks.map((sub) => (
            <View
              key={sub.id}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingVertical: 6,
                paddingHorizontal: 8,
                borderRadius: 8,
                backgroundColor: theme.colors.surface2,
              }}
            >
              <Pressable
                accessibilityRole="button"
                onPress={async () => {
                  const nextStatus: TaskStatus =
                    sub.status === "done" ? "todo" : "done";
                  await updateTask({
                    taskId: sub.id,
                    status: nextStatus,
                    authorName: "You",
                  });
                  invalidateAll();
                }}
              >
                <StatusIcon status={sub.status} theme={theme} size={15} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => onSelectTaskKey?.(sub.key)}
                style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6 }}
              >
                <Text
                  style={{
                    color: theme.colors.foregroundMuted,
                    fontSize: 11,
                    fontWeight: "700",
                  }}
                >
                  {sub.key}
                </Text>
                <Text
                  numberOfLines={1}
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 13,
                    flex: 1,
                    textDecorationLine:
                      sub.status === "done" ? "line-through" : "none",
                  }}
                >
                  {sub.title}
                </Text>
              </Pressable>
              <PriorityBadge priority={sub.priority} theme={theme} />
            </View>
          ))}

          <View style={{ flexDirection: "row", gap: 8 }}>
            <TextInput
              value={newSubtaskTitle}
              onChangeText={setNewSubtaskTitle}
              placeholder="Add a sub-task…"
              placeholderTextColor={theme.colors.foregroundMuted}
              onSubmitEditing={() => void handleCreateSubtask()}
              style={{
                flex: 1,
                paddingHorizontal: 10,
                paddingVertical: 7,
                borderRadius: 8,
                backgroundColor: theme.colors.surface2,
                color: theme.colors.foreground,
                fontSize: 12,
              }}
            />
            <Pressable
              accessibilityRole="button"
              onPress={() => void handleCreateSubtask()}
              style={{
                paddingHorizontal: 12,
                justifyContent: "center",
                borderRadius: 8,
                backgroundColor: theme.colors.surface2,
              }}
            >
              <Text
                style={{
                  color: theme.colors.foreground,
                  fontSize: 12,
                  fontWeight: "600",
                }}
              >
                + Add
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* Attached Agent Threads & Pull Requests */}
      <View
        style={{
          padding: 12,
          borderRadius: 10,
          backgroundColor: theme.colors.surface1,
          borderWidth: 1,
          borderColor: theme.colors.border,
          gap: 10,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Text
            style={{
              color: theme.colors.foreground,
              fontSize: 13,
              fontWeight: "700",
            }}
          >
            Worker Threads ({taskThreads.length})
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => setShowAttachAgent((prev) => !prev)}
            style={{
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderRadius: 6,
              backgroundColor: theme.colors.surface2,
            }}
          >
            <Text style={{ color: theme.colors.foreground, fontSize: 11 }}>
              {showAttachAgent ? "Close" : "+ Attach Agent"}
            </Text>
          </Pressable>
        </View>

        {showAttachAgent ? (
          <View
            style={{
              padding: 10,
              borderRadius: 8,
              backgroundColor: theme.colors.surface2,
              gap: 8,
            }}
          >
            <TextInput
              value={agentSearchQuery}
              onChangeText={setAgentSearchQuery}
              placeholder="Search running or idle Paseo agents…"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 6,
                backgroundColor: theme.colors.surface1,
                color: theme.colors.foreground,
                fontSize: 12,
              }}
            />
            {(searchThreadsQuery.data?.threads ?? []).map((candidate) => (
              <Pressable
                key={candidate.id}
                accessibilityRole="button"
                onPress={async () => {
                  try {
                    await attachTaskThread({
                      taskId: task.id,
                      threadId: candidate.id,
                    });
                    setShowAttachAgent(false);
                    invalidateAll();
                    toast.show("Attached agent to task", {
                      variant: "success",
                    });
                  } catch (error) {
                    toast.error(
                      error instanceof Error ? error.message : String(error),
                    );
                  }
                }}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  paddingVertical: 6,
                  paddingHorizontal: 8,
                  borderRadius: 6,
                  backgroundColor: theme.colors.surface1,
                }}
              >
                <Text
                  numberOfLines={1}
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 12,
                    flex: 1,
                  }}
                >
                  {candidate.title}
                </Text>
                <Text
                  style={{
                    color: theme.colors.foregroundMuted,
                    fontSize: 11,
                  }}
                >
                  {candidate.status}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {taskThreads.length === 0 ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            No agent threads attached yet. Dispatch a preset above or run{" "}
            paseo-tasks attach {task.key}.
          </Text>
        ) : (
          taskThreads.map((tt) => (
            <View
              key={tt.id}
              style={{
                padding: 10,
                borderRadius: 8,
                backgroundColor: theme.colors.surface2,
                gap: 6,
              }}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <Text
                  numberOfLines={1}
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 13,
                    fontWeight: "600",
                    flex: 1,
                  }}
                >
                  {tt.title}
                </Text>
                <ThreadLiveStatusBadge status={tt.liveStatus} theme={theme} />
              </View>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <Text
                  style={{
                    color: theme.colors.foregroundMuted,
                    fontSize: 11,
                  }}
                >
                  {tt.presetName} · {tt.threadId.slice(0, 8)}
                </Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  {openAgent ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => openAgent({ agentId: tt.threadId })}
                      style={{
                        paddingHorizontal: 8,
                        paddingVertical: 3,
                        borderRadius: 6,
                        backgroundColor: theme.colors.accent,
                      }}
                    >
                      <Text
                        style={{
                          color: theme.colors.accentForeground,
                          fontSize: 11,
                          fontWeight: "600",
                        }}
                      >
                        Open Agent
                      </Text>
                    </Pressable>
                  ) : null}
                  {openWorkspace && tt.workspaceId ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() =>
                        openWorkspace({ workspaceId: tt.workspaceId! })
                      }
                      style={{
                        paddingHorizontal: 8,
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
                        Workspace
                      </Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    accessibilityRole="button"
                    onPress={async () => {
                      try {
                        await detachTaskThread({
                          taskId: task.id,
                          threadId: tt.threadId,
                        });
                        invalidateAll();
                        toast.show("Detached agent", { variant: "info" });
                      } catch (error) {
                        toast.error(
                          error instanceof Error
                            ? error.message
                            : String(error),
                        );
                      }
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
                        color: theme.colors.foregroundMuted,
                        fontSize: 11,
                      }}
                    >
                      Detach
                    </Text>
                  </Pressable>
                </View>
              </View>
            </View>
          ))
        )}

        {pullRequests.length > 0 ? (
          <View style={{ gap: 6, marginTop: 4 }}>
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 11,
                fontWeight: "600",
              }}
            >
              PULL REQUESTS
            </Text>
            {pullRequests.map((pr) => (
              <View
                key={pr.url}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: 8,
                  borderRadius: 8,
                  backgroundColor: theme.colors.surface2,
                }}
              >
                <ExternalLink href={pr.url}>
                  <Text
                    style={{
                      color: theme.colors.accent,
                      fontSize: 12,
                      fontWeight: "600",
                    }}
                  >
                    #{pr.number} · {pr.title} ({pr.state})
                  </Text>
                </ExternalLink>
              </View>
            ))}
          </View>
        ) : null}
      </View>

      {/* Attachments Card */}
      <View
        style={{
          padding: 12,
          borderRadius: 10,
          backgroundColor: theme.colors.surface1,
          borderWidth: 1,
          borderColor: theme.colors.border,
          gap: 10,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Text
            style={{
              color: theme.colors.foreground,
              fontSize: 13,
              fontWeight: "700",
            }}
          >
            Attachments ({attachments.length})
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => setShowNewNoteAttachment((prev) => !prev)}
            style={{
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderRadius: 6,
              backgroundColor: theme.colors.surface2,
            }}
          >
            <Text style={{ color: theme.colors.foreground, fontSize: 11 }}>
              {showNewNoteAttachment ? "Cancel" : "+ Add Artifact"}
            </Text>
          </Pressable>
        </View>

        {showNewNoteAttachment ? (
          <View
            style={{
              padding: 10,
              borderRadius: 8,
              backgroundColor: theme.colors.surface2,
              gap: 8,
            }}
          >
            <TextInput
              value={noteFileName}
              onChangeText={setNoteFileName}
              placeholder="Filename (e.g. spec.md)"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 6,
                backgroundColor: theme.colors.surface1,
                color: theme.colors.foreground,
                fontSize: 12,
              }}
            />
            <TextInput
              value={noteContent}
              onChangeText={setNoteContent}
              multiline
              placeholder="Paste artifact content…"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={{
                minHeight: 70,
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 6,
                backgroundColor: theme.colors.surface1,
                color: theme.colors.foreground,
                fontSize: 12,
                textAlignVertical: "top",
              }}
            />
            <Pressable
              accessibilityRole="button"
              onPress={() => void handleAddNoteAttachment()}
              style={{
                alignSelf: "flex-end",
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 6,
                backgroundColor: theme.colors.accent,
              }}
            >
              <Text
                style={{
                  color: theme.colors.accentForeground,
                  fontSize: 12,
                  fontWeight: "600",
                }}
              >
                Save Attachment
              </Text>
            </Pressable>
          </View>
        ) : null}

        {attachments.length === 0 ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            No files attached. Agents can attach files with paseo-tasks
            attachment add {task.key} --file ./path.
          </Text>
        ) : (
          attachments.map((att) => (
            <View
              key={att.id}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                padding: 8,
                borderRadius: 8,
                backgroundColor: theme.colors.surface2,
                gap: 8,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text
                  numberOfLines={1}
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 12,
                    fontWeight: "600",
                  }}
                >
                  {att.fileName}
                </Text>
                <Text
                  style={{
                    color: theme.colors.foregroundMuted,
                    fontSize: 11,
                  }}
                >
                  {att.mime} · {att.sizeBytes} B · {att.id.slice(0, 8)}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                onPress={async () => {
                  try {
                    await copyText(
                      attachmentGetCommand(att.id, att.fileName),
                    );
                    toast.show("Copied CLI download command", {
                      variant: "success",
                    });
                  } catch {}
                }}
                style={{
                  paddingHorizontal: 7,
                  paddingVertical: 4,
                  borderRadius: 6,
                  backgroundColor: theme.colors.surface1,
                }}
              >
                <Text style={{ color: theme.colors.foreground, fontSize: 11 }}>
                  Copy CLI
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={async () => {
                  const res = await deleteAttachment({
                    attachmentId: att.id,
                    removeDescriptionReferences: true,
                  });
                  if (!res.ok) {
                    toast.error(res.error.message);
                    return;
                  }
                  invalidateAll();
                  toast.show("Attachment removed", { variant: "info" });
                }}
                style={{
                  paddingHorizontal: 6,
                  paddingVertical: 4,
                  borderRadius: 6,
                  backgroundColor: theme.colors.surface1,
                }}
              >
                <Icon
                  name="Trash2"
                  size={12}
                  color={theme.colors.statusDanger}
                />
              </Pressable>
            </View>
          ))
        )}
      </View>

      {/* Activity & Comments */}
      <View
        style={{
          padding: 12,
          borderRadius: 10,
          backgroundColor: theme.colors.surface1,
          borderWidth: 1,
          borderColor: theme.colors.border,
          gap: 12,
        }}
      >
        <Text
          style={{
            color: theme.colors.foreground,
            fontSize: 13,
            fontWeight: "700",
          }}
        >
          Activity & Comments ({comments.length})
        </Text>

        {comments.map((comment) => {
          const isSystem = comment.kind === "system";
          const isAgent = comment.kind === "agent";
          // A comment from another task's agent (a subtask worker) names that task.
          const fromKey = comment.threadTitle?.match(/^([A-Z][A-Z0-9]*-\d+) · /)?.[1];
          const author = isAgent
            ? [fromKey && fromKey !== task.key ? fromKey : null, comment.presetName ?? comment.authorName]
                .filter(Boolean)
                .join(" · ")
            : comment.authorName;
          return (
            <View
              key={comment.id}
              style={{
                padding: isSystem ? 8 : 10,
                borderRadius: 8,
                backgroundColor: isSystem
                  ? theme.colors.surface0
                  : theme.colors.surface2,
                gap: 4,
              }}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 6,
                }}
              >
                <View
                  style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1, minWidth: 0 }}
                >
                  <Text
                    numberOfLines={1}
                    style={{
                      flexShrink: 1,
                      color: isSystem
                        ? theme.colors.foregroundMuted
                        : theme.colors.foreground,
                      fontSize: 12,
                      fontWeight: "700",
                    }}
                  >
                    {author}
                  </Text>
                  {comment.notifiedCount > 0 ? (
                    <Text
                      style={{
                        color: theme.colors.statusSuccess,
                        fontSize: 10,
                        fontWeight: "600",
                      }}
                    >
                      · Notified agent
                    </Text>
                  ) : null}
                </View>
                <Text
                  style={{
                    flexShrink: 0,
                    color: theme.colors.foregroundMuted,
                    fontSize: 11,
                  }}
                >
                  {formatRelativeTime(comment.createdAt)}
                </Text>
              </View>
              <Text
                selectable
                style={{
                  color: isSystem
                    ? theme.colors.foregroundMuted
                    : theme.colors.foreground,
                  fontSize: isSystem ? 12 : 13,
                  lineHeight: 19,
                }}
              >
                {comment.body}
              </Text>
            </View>
          );
        })}

        {/* Comment Composer */}
        <View style={{ gap: 8, marginTop: 4 }}>
          <TextInput
            value={commentDraft}
            onChangeText={setCommentDraft}
            multiline
            placeholder="Leave a Markdown comment…"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={{
              minHeight: 72,
              paddingHorizontal: 10,
              paddingVertical: 8,
              borderRadius: 8,
              backgroundColor: theme.colors.surface2,
              color: theme.colors.foreground,
              fontSize: 13,
              textAlignVertical: "top",
            }}
          />

          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <Pressable
              accessibilityRole="button"
              disabled={!notifyTargetThreadId}
              onPress={() => setNotifyAgent((prev) => !prev)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                opacity: notifyTargetThreadId ? 1 : 0.55,
              }}
            >
              <View
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 4,
                  borderWidth: 1,
                  borderColor:
                    notifyTargetThreadId && notifyAgent
                      ? theme.colors.accent
                      : theme.colors.border,
                  backgroundColor:
                    notifyTargetThreadId && notifyAgent
                      ? theme.colors.accent
                      : theme.colors.surface2,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {notifyTargetThreadId && notifyAgent ? (
                  <Icon
                    name="Check"
                    size={11}
                    color={theme.colors.accentForeground}
                  />
                ) : null}
              </View>
              <Text
                style={{
                  color: theme.colors.foregroundMuted,
                  fontSize: 12,
                }}
              >
                {notifyTargetThreadId
                  ? `Notify last responding agent (${notifyTargetLabel})`
                  : "Notify last responding agent (no agent attached yet)"}
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              disabled={postingComment || !commentDraft.trim()}
              onPress={() => void handlePostComment()}
              style={{
                paddingHorizontal: 14,
                paddingVertical: 8,
                borderRadius: 8,
                backgroundColor: theme.colors.accent,
                opacity: postingComment || !commentDraft.trim() ? 0.5 : 1,
              }}
            >
              <Text
                style={{
                  color: theme.colors.accentForeground,
                  fontSize: 12,
                  fontWeight: "700",
                }}
              >
                {postingComment ? "Posting…" : "Comment"}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

// A suggestion from a folder with no Tasks project: pick where it belongs, and
// optionally send that folder's future work to the same project.
function AcceptIntoProject({
  theme,
  task,
  projects,
  onAccepted,
}: {
  theme: PluginTheme;
  task: Task;
  projects: Project[];
  onAccepted: (key: string) => void;
}) {
  const toast = useToast();
  const moveTaskToProject = useRpc(moveTaskToProjectRpc);
  const updateTask = useRpc(updateTaskRpc);
  const updateProject = useRpc(updateProjectRpc);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [linkFolder, setLinkFolder] = useState(true);
  const [busy, setBusy] = useState(false);
  const target = projects.find((p) => p.id === targetId) ?? null;
  const canLink = Boolean(task.sourceBbProjectId && target && !target.linkedBbProjectId);

  async function accept() {
    if (!target || busy) return;
    setBusy(true);
    try {
      const moved = await moveTaskToProject({ taskId: task.id, projectId: target.id });
      if (!moved.ok) throw new Error(moved.error.message);
      const accepted = await updateTask({ taskId: task.id, idea: false, authorName: "You" });
      if (!accepted.ok) throw new Error(accepted.error.message);
      if (canLink && linkFolder) {
        await updateProject({
          projectId: target.id,
          linkedBbProjectId: task.sourceBbProjectId,
        });
      }
      toast.show(`Accepted as ${moved.task.key}`, { variant: "success" });
      onAccepted(moved.task.key);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const chip = (selected: boolean) => ({
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: selected ? theme.colors.surface2 : "transparent",
    borderWidth: 1,
    borderColor: theme.colors.border,
  });

  return (
    <View
      style={{
        padding: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
        gap: 10,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
        Accept into
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {projects.map((p) => (
          <Pressable
            key={p.id}
            accessibilityRole="button"
            accessibilityState={{ selected: p.id === targetId }}
            onPress={() => setTargetId(p.id)}
            style={chip(p.id === targetId)}
          >
            <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>
              {p.prefix} {p.name}
            </Text>
          </Pressable>
        ))}
      </View>
      {canLink ? (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: linkFolder }}
          onPress={() => setLinkFolder((v) => !v)}
          style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
        >
          <View
            style={{
              width: 14,
              height: 14,
              borderRadius: 3,
              borderWidth: 1,
              borderColor: theme.colors.foregroundMuted,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {linkFolder ? (
              <Icon name="Check" size={11} color={theme.colors.foreground} />
            ) : null}
          </View>
          <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>
            Send future work from this folder to {target!.prefix}
          </Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        disabled={!target || busy}
        onPress={() => void accept()}
        style={{
          alignSelf: "flex-start",
          paddingHorizontal: 10,
          paddingVertical: 6,
          borderRadius: 7,
          backgroundColor: theme.colors.accent,
          opacity: !target || busy ? 0.5 : 1,
        }}
      >
        <Text style={{ color: theme.colors.accentForeground, fontSize: 12, fontWeight: "600" }}>
          {target ? `Accept into ${target.prefix}` : "Accept"}
        </Text>
      </Pressable>
    </View>
  );
}
