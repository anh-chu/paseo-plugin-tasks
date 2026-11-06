import type {
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import React, { useLayoutEffect, useRef } from "react";
import { Platform, View } from "react-native";
import { TASK_CARD_KIND, TASK_TEXT_KIND } from "./shared/constants";
import {
  listSessionIdeasRpc,
  seedDemoRpc,
  taskCardDataSchema,
  tasksAttachmentSource,
  taskTextDataSchema,
} from "./shared/contract";
import { transformAssistantTaskDirectives } from "./shared/directive";
import { AdoptPicker, setAdoptClient, SuggestionPopover } from "./client/adopt";
import {
  TaskAgentPanel,
  TasksScreen,
  TasksSidebarItem,
  TasksWorkspacePanel,
} from "./client/screen";
import {
   TasksSettingsScreen,
  TaskTimelineCardItem,
  TaskTimelineTextItem,
} from "./client/timeline-card";
import type { Task } from "./shared/contract";

// Accent color sets the suggestion pill apart from the status pills beside it.
// The pill API styles only the icon, so on the web (where a view's ref is its
// DOM element) the icon also colors the label next to its slot, as the
// annotations plugin does; native apps get the colored icon only.
type DomElement = {
  parentElement: DomElement | null;
  nextElementSibling: DomElement | null;
  style: { setProperty(name: string, value: string): void };
};

function SuggestionIcon({ theme, size }: PluginButtonIconProps) {
  const ref = useRef<View>(null);
  useLayoutEffect(() => {
    if (Platform.OS !== "web") return;
    const label = (ref.current as unknown as DomElement | null)?.parentElement
      ?.nextElementSibling;
    label?.style.setProperty("color", theme.colors.accent);
    label?.style.setProperty("font-weight", "600");
  });
  return (
    <View ref={ref}>
      <Icon name="Lightbulb" size={size} color={theme.colors.accent} />
    </View>
  );
}

export default function contribute(client: PluginClientContext) {
  setAdoptClient(client);

  // 1. Main Screen & Sidebar Header Item
  client.addScreen({
    id: "main",
    title: (params) => (params.taskKey ? `Tasks · ${params.taskKey}` : "Tasks"),
    Component: TasksScreen,
  });

  client.addSidebarHeaderItem({
    id: "tasks",
    title: "Tasks",
    Component: TasksSidebarItem,
  });

  // 2. Workspace & Agent Panels
  client.addWorkspacePanel({
    id: "tasks-board",
    title: "Tasks",
    icon: "ListTodo",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: TasksWorkspacePanel,
  });

  client.addWorkspacePanel({
    id: "task-detail",
    title: "Task",
    icon: "ListTodo",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: TaskAgentPanel,
  });

  // 3. Settings Screen
  client.addSettingsScreen({
    id: "preferences",
    title: "Tasks",
    icon: "ListTodo",
    Component: TasksSettingsScreen,
  });

  // 4. Composer Attachment Source (@ / + picker)
  client.addAttachmentSource(tasksAttachmentSource);

  // 5. Timeline Transformer & Renderers for ::task{key="PROD-1"}
  client.addTimelineTransformer({
    id: "tasks-directive",
    query: { itemType: "assistant_message" },
    transform({ item, phase }) {
      return transformAssistantTaskDirectives(item.text, phase);
    },
  });

  client.addTimelineRenderer({
    kind: TASK_CARD_KIND,
    version: 1,
    schema: taskCardDataSchema,
    Component: (props) => (
      <TaskTimelineCardItem
        {...props}
        onOpenTask={(taskKey) =>
          client.openScreen({ screenId: "main", params: { taskKey } })
        }
      />
    ),
  });

  client.addTimelineRenderer({
    kind: TASK_TEXT_KIND,
    version: 1,
    schema: taskTextDataSchema,
    Component: TaskTimelineTextItem,
  });

  // 6. Slash Commands
  client.addSlashCommand({
    name: "tasks",
    description: "Open Paseo Tasks board or a specific task key (e.g. /tasks PROD-1)",
    argumentHint: "[TASK-KEY]",
    context: "workspace",
    onSubmit({ args, openScreen }) {
      const trimmed = args.trim().toUpperCase();
      if (trimmed) {
        openScreen({ screenId: "main", params: { taskKey: trimmed } });
      } else {
        openScreen({ screenId: "main" });
      }
    },
  });

  client.addSlashCommand({
    name: "task-panel",
    description: "Open the Task inspector panel beside this agent",
    argumentHint: "",
    context: "agent",
    onSubmit({ openPanel }) {
      openPanel("task-detail");
    },
  });

  // 7. Command Center Items
  client.addCommandCenterItem({
    id: "open-tasks",
    title: "Tasks: Open Board & List",
    icon: "ListTodo",
    keywords: ["tasks", "kanban", "board", "linear", "tracker", "delegate"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "main" });
    },
  });

  client.addCommandCenterItem({
    id: "open-workspace-tasks",
    title: "Tasks: Open Workspace Board Panel",
    icon: "ListTodo",
    keywords: ["tasks", "board", "panel", "kanban"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("tasks-board");
    },
  });

  client.addCommandCenterItem({
    id: "open-agent-task",
    title: "Tasks: Open Agent Task Inspector",
    icon: "ListTodo",
    keywords: ["task", "agent", "delegate", "thread"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel("task-detail");
    },
  });

  client.addCommandCenterItem({
    id: "seed-demo-tasks",
    title: "Tasks: Seed Sample Projects & Tasks",
    icon: "Sparkles",
    keywords: ["tasks", "seed", "demo", "sample"],
    context: "global",
    async onSelect({ rpc, openScreen }) {
      await rpc(seedDemoRpc, {});
      openScreen({ screenId: "main" });
    },
  });

  // 8. Composer Pill per Agent (shows linked task key or "Task" button)
  const pills = new Map<string, PluginButtonRegistration>();
  const lifetime = new AbortController();

  // 9. Suggestion pill per agent: ideas the session proposed, shown beside the
  // composer so they do not depend on a ::task line in the reply.
  const suggestionPills = new Map<string, PluginButtonRegistration>();
  let ideasByAgent = new Map<string, Task[]>();

  const applySuggestions = (agentId: string) => {
    const pill = suggestionPills.get(agentId);
    if (!pill) return;
    const ideas = ideasByAgent.get(agentId) ?? [];
    if (ideas.length === 0) return pill.update({ visible: false });
    pill.update({
      visible: true,
      title: ideas.map((task) => task.title).join("\n"),
      icon: SuggestionIcon,
      label: ideas.length === 1 ? "1 suggestion" : `${ideas.length} suggestions`,
      behavior: {
        kind: "popover",
        Content: ({ theme, close }) => (
          <>
            {ideas.map((task) => (
              <SuggestionPopover
                key={task.id}
                theme={theme}
                task={task}
                onDone={() => {
                  close();
                  void pollSuggestions();
                }}
                onOpenTask={() => {
                  close();
                  client.openScreen({ screenId: "main", params: { taskKey: task.key } });
                }}
              />
            ))}
          </>
        ),
      },
    });
  };

  const pollSuggestions = async () => {
    const { ideas } = await client.rpc(listSessionIdeasRpc, {});
    const next = new Map<string, Task[]>();
    for (const { threadId, task } of ideas) {
      next.set(threadId, [...(next.get(threadId) ?? []), task]);
    }
    ideasByAgent = next;
    for (const agentId of suggestionPills.keys()) applySuggestions(agentId);
  };

  // ponytail: polls because the plugin gets no push event when an idea is
  // proposed; switch to a subscription if the bridge ever emits task changes.
  const suggestionTimer = setInterval(() => void pollSuggestions().catch(() => undefined), 5000);
  void pollSuggestions().catch(() => undefined);

  const registerPill = (agent: {
    id: string;
    workspaceId?: string | null;
    title?: string | null;
    labels?: Record<string, string>;
  }) => {
    if (lifetime.signal.aborted || !agent.workspaceId) return;
    const agentId = agent.id;
    const workspaceId = agent.workspaceId;
    const taskKey = agent.labels?.taskKey;
    suggestionPills.get(agentId)?.remove();
    suggestionPills.set(
      agentId,
      client.addComposerPill({
        id: "task-suggestion",
        workspaceId,
        agentId,
        button: {
          title: "Suggested task",
          icon: "Lightbulb",
          visible: false,
          behavior: { kind: "action", onPress() {} },
        },
      }),
    );
    applySuggestions(agentId);
    pills.get(agentId)?.remove();
    pills.set(
      agentId,
      client.addComposerPill({
        id: "task-pill",
        workspaceId,
        agentId,
        button: taskKey
          ? {
              title: `Open task ${taskKey}`,
              icon: "ListTodo",
              label: taskKey,
              behavior: {
                kind: "action",
                onPress() {
                  client.openPanel("task-detail", { workspaceId, agentId });
                },
              },
            }
          : {
              title: "Add this session to a task",
              icon: "ListTodo",
              label: "Task",
              behavior: {
                kind: "popover",
                Content: ({ theme, close }) => {
                  const openPanel = () => {
                    close();
                    client.openPanel("task-detail", { workspaceId, agentId });
                  };
                  return (
                    <AdoptPicker
                      theme={theme}
                      agentId={agentId}
                      agentTitle={agent.title ?? ""}
                      workspaceId={workspaceId}
                      onAdopted={openPanel}
                      onOpenTask={openPanel}
                    />
                  );
                },
              },
            },
      }),
    );
  };

  const removeAllPills = () => {
    for (const pill of pills.values()) pill.remove();
    pills.clear();
    for (const pill of suggestionPills.values()) pill.remove();
    suggestionPills.clear();
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          removeAllPills();
          for (const { agent } of entries) registerPill(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") return registerPill(update.agent);
          pills.get(update.agentId)?.remove();
          pills.delete(update.agentId);
          suggestionPills.get(update.agentId)?.remove();
          suggestionPills.delete(update.agentId);
        },
      });
      return undefined;
    })
    .catch(() => undefined);

  return () => {
    lifetime.abort();
    clearInterval(suggestionTimer);
    removeAllPills();
  };
}
