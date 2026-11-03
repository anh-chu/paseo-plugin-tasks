Tasks is a local task tracker inside Paseo: projects, folders, subtasks, labels, comments, and file attachments, shown as a kanban board and a grouped list. You can hand a task to a coding agent in one click, and the agent reports progress back to the same task.

The board is the working surface. Drag a card between columns or within one, or use its status menu, to change status and order. Type a title at the top of a column to add a task there. Each card shows what its agents last said and when. Filter by project, label, priority, or text, and sort by manual position, priority, or due date. Opening a task shows its description, status, priority, labels, due date, sub-tasks, attachments, comments, and the agent sessions attached to it. A column collapses to a narrow strip when you click its title. **Needs you** lists every task in review across all projects.

Sessions you started without a task can join the tracker later. The **Task** pill beside the composer of a session with no task opens a picker: create a task from the session, with its title filled in, or attach the session to an open task. On a project linked to a Paseo project, the board starts with a collapsed **Sessions without a task** column listing that project's live sessions that no task has adopted. Expand it to create a task for one session, attach a session to a task, or create a task for each.

A project can also define its own stages, such as Investigate, Spec, Build and Review. Stages are optional and off until a project lists them. Status still says who has the work; the stage says where the work is. The board can then group by stage instead of status, the task view gets a stage picker, and every stage change is recorded as a comment.

## How delegation works

Each task can be dispatched to an agent using a reusable preset. A preset fixes the provider and model, a thinking level, an optional service tier, a permission mode, and where the agent runs: either in the task's linked Paseo project or in a fresh git worktree branched from it. Dispatch builds a seed prompt from the task, its sub-tasks, attachments, recent comments, the agent sessions already attached to it, and any extra instructions you type, then creates the agent and attaches it to the task.

Worker agents report through two channels that the plugin installs for them:

- A `paseo-tasks` command on their `PATH` (also aliased as `bb-tasks` and `bb`), so they can list, create, update, comment on, and attach files to tasks from a shell.
- A `tasks` MCP server with the same operations as tools, for agents that prefer MCP over shell commands.

Both channels talk to the running daemon over a loopback HTTP bridge. When an agent writes `::task{key="ABC-12"}` on its own line in a reply, Paseo replaces that line with a live task card that opens the task.

An optional setting, off by default, makes CLI and MCP submissions to review or completion require a comment describing checks and gaps. A blocked or failed check can be submitted for review; completion requires a passing verdict or an explanation that nothing was checkable. The check validates the comment format, not the claims. A person can change the status in the app.

Comment steering closes the loop the other way. Writing a comment with **Notify agent** on sends it to the agent that last replied on the task, or to the most recently attached session, as new context for the work in progress.

Agent sessions are tracked through Paseo's lifecycle events. When a session starts, finishes a turn, fails, or closes, the task records the new state; a terminal state also leaves a comment on the task. When the plugin loads, it refreshes sessions still shown as running, so events missed during a daemon restart do not leave a stale state.

A preset can schedule a check-in: every hour, weekdays at 9:00, or every day at 9:00. Dispatching with that preset gives the new agent a recurring check-in message, which is removed when the task is done or canceled, or the session is detached or archived. This suits a lead agent that works through a parent task's sub-tasks over several days.

## Setup

Requires Paseo 0.11.2 or later on the daemon and the app, and Node 24 or later on the daemon host, because the task store uses the built-in `node:sqlite` module.

Two settings control agent integration and are on by default. **Inject paseo-tasks CLI and MCP server** adds the command directory to an agent's `PATH` and registers the MCP server on new agents. **Inject Tasks reporting instructions** appends a short workflow to the agent's system prompt. At the start of real work the agent checks the board, attaches to a matching open task or suggests a new one for you to approve, comments at milestones, and moves the task to In review when done. Suggestions from a folder that is not linked to a project go to a built-in **Unsorted** project; approving one lets you pick the project and link the folder to it. The instructions apply to sessions created after installation. A third setting, off by default, tells the parent task when a sub-task's agent ends a turn without commenting or changing the status: the sub-task gets a comment and the parent task's agent is notified, once until that agent reports again. Board and list settings choose the default view and whether finished tasks appear on the board.

Dispatching into a new worktree needs a git-backed Paseo project. Runs that need no worktree work with any project. Pull request status on an attached session appears only when the GitHub CLI (`gh`) is installed on the daemon host and the workspace is a GitHub checkout.

## Capabilities and data access

- **Store**: one SQLite database at `$PASEO_HOME/plugin-data/tasks/tasks.db` in WAL mode, with schema migrations applied on load. Task keys are `PREFIX-NUMBER` per project; moving a task to another project keeps its old key working as an alias.
- **Attachments**: files up to 25 MB are stored under the plugin data directory and served back to the client; each attachment keeps its filename, size, and content type.
- **Local bridge**: the plugin serves a small HTTP endpoint on loopback with a random bearer token written to `$PASEO_HOME/plugin-data/tasks/bridge.json` with owner-only permissions. It also writes the `paseo-tasks`, `bb-tasks`, `bb`, and `tasks-mcp.mjs` helper scripts into `$PASEO_HOME/plugin-data/tasks/bin`. The CLI and MCP server refuse to run when the bridge is absent, so there is no separate offline store.
- **Daemon connection**: the `paseo` CLI must be on the daemon's `PATH` for delegation and attachment to connect before the plugin has received a Paseo API context.
- **Reads**: the Paseo project list, project root paths, agent lifecycle events, and workspace creation. The plugin writes nothing to a workspace until you dispatch a task into a new worktree.
- **Agents**: when you dispatch a task or send a comment with **Notify agent**, the task text, sub-tasks, comments, and any attachment content the agent reads go to that agent's model provider and follow that provider's data policy.
- **Check-ins**: a preset with a check-in runs `paseo heartbeat create` for the new agent when you dispatch, and `paseo heartbeat delete` when the check-in ends. If the command fails, dispatch still succeeds and the task gets a comment saying so.
- **GitHub CLI**: when `gh` is available, the plugin runs `gh pr view` in a workspace directory to show pull request state for sessions attached to a task. No other network requests are made.

## Limits

The CLI and MCP server require the Paseo daemon to be running. Lists return at most 500 rows per page.
