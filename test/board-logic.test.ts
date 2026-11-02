import { describe, expect, it } from "vitest";
import {
  agentExcerpt,
  columnAt,
  currentNeighbors,
  dropIndex,
  dropNeighbors,
} from "../client/board-logic";

const task = (id: string, position: number, projectId = "p1", status = "todo") => ({
  id,
  projectId,
  status,
  position,
});

describe("board drops", () => {
  const column = [task("a", 1), task("b", 2), task("c", 3)];

  it("finds the neighbors a task moves between within its column", () => {
    expect(dropNeighbors(column, column[2]!, 0, "todo")).toEqual({ beforeTaskId: null, afterTaskId: "a" });
    expect(dropNeighbors(column, column[0]!, 1, "todo")).toEqual({ beforeTaskId: "b", afterTaskId: "c" });
    expect(dropNeighbors(column, column[0]!, 2, "todo")).toEqual({ beforeTaskId: "c", afterTaskId: null });
  });

  it("finds neighbors in another column", () => {
    const moving = task("x", 1, "p1", "backlog");
    expect(dropNeighbors(column, moving, 1, "todo")).toEqual({ beforeTaskId: "a", afterTaskId: "b" });
    expect(dropNeighbors([], moving, 0, "todo")).toEqual({ beforeTaskId: null, afterTaskId: null });
  });

  it("skips tasks of other projects and statuses", () => {
    const mixed = [task("a", 1), task("o", 1, "p2"), task("s", 5, "p1", "done"), task("b", 2)];
    const moving = task("x", 9, "p1", "backlog");
    expect(dropNeighbors(mixed, moving, 2, "todo")).toEqual({ beforeTaskId: "a", afterTaskId: "b" });
  });

  it("remembers a task's neighbors for undo", () => {
    expect(currentNeighbors([column[2]!, column[0]!, column[1]!], column[1]!)).toEqual({
      beforeTaskId: "a",
      afterTaskId: "c",
    });
  });

  it("maps a pointer to a column and a drop index", () => {
    const columns = [
      { key: "todo", x: 0, width: 100 },
      { key: "done", x: 110, width: 100 },
    ];
    expect(columnAt(50, columns)).toBe("todo");
    expect(columnAt(105, columns)).toBeNull();
    expect(columnAt(150, columns)).toBe("done");
    const cards = [
      { y: 0, height: 40 },
      { y: 50, height: 40 },
    ];
    expect(dropIndex(10, cards)).toBe(0);
    expect(dropIndex(30, cards)).toBe(1);
    expect(dropIndex(200, cards)).toBe(2);
  });
});

describe("agent excerpt", () => {
  it("shows the first line without markdown markers", () => {
    expect(agentExcerpt("## Running tests\n\nmore")).toBe("Running tests");
    expect(agentExcerpt("\n- Fixed the build")).toBe("Fixed the build");
    expect(agentExcerpt("   ")).toBeNull();
    expect(agentExcerpt(null)).toBeNull();
  });
});
