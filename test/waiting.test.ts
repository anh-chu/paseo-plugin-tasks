import { describe, expect, it } from "vitest";
import { toWaitingRequest } from "../server/domain";

const thread = { threadId: "agent-1", title: "Playbook Manager", workspaceId: "wks_1" };

describe("toWaitingRequest", () => {
  it("reads an AskUserQuestion gate into questions with options", () => {
    const waiting = toWaitingRequest(thread, {
      id: "perm-1",
      name: "AskUserQuestion",
      kind: "question",
      input: {
        questions: [
          {
            header: "Spec gate",
            question: "Approve the spec?",
            multiSelect: false,
            options: [{ label: "Approve", description: "Go on" }, { label: "Request changes" }, { nope: true }],
          },
        ],
      },
    });
    expect(waiting).toMatchObject({ threadId: "agent-1", workspaceId: "wks_1", requestId: "perm-1", kind: "question" });
    expect(waiting.questions).toEqual([
      {
        header: "Spec gate",
        question: "Approve the spec?",
        multiSelect: false,
        options: [
          { label: "Approve", description: "Go on" },
          { label: "Request changes", description: "" },
        ],
      },
    ]);
  });

  it("falls back to the question text when a question has no header", () => {
    const waiting = toWaitingRequest(thread, {
      id: "perm-2",
      name: "AskUserQuestion",
      kind: "question",
      input: { questions: [{ question: "Which one?", options: [] }] },
    });
    expect(waiting.questions[0]?.header).toBe("Which one?");
  });

  it("reads a tool permission with its title and actions", () => {
    const waiting = toWaitingRequest({ ...thread, workspaceId: null }, {
      id: "perm-3",
      name: "Bash",
      kind: "tool",
      description: "rm -rf build",
      actions: [{ id: "a", label: "Allow once", behavior: "allow" }],
    });
    expect(waiting).toMatchObject({ title: "Bash", description: "rm -rf build", workspaceId: null, questions: [] });
    expect(waiting.actions).toEqual([{ id: "a", label: "Allow once", behavior: "allow" }]);
  });
});
