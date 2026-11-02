// Pure board helpers, kept free of React Native so tests can run them.

export interface PlacedTask {
  id: string;
  projectId: string;
  status: string;
  position: number;
}

export interface Neighbors {
  beforeTaskId: string | null;
  afterTaskId: string | null;
}

// A task's neighbors in its own project and status, so a move can be undone
// back to the same place.
export function currentNeighbors(
  tasks: readonly PlacedTask[],
  task: PlacedTask,
): Neighbors {
  const column = tasks
    .filter((t) => t.projectId === task.projectId && t.status === task.status)
    .sort((a, b) => a.position - b.position);
  const index = column.findIndex((t) => t.id === task.id);
  return {
    beforeTaskId: column[index - 1]?.id ?? null,
    afterTaskId: column[index + 1]?.id ?? null,
  };
}

// Where a task dropped at `index` of a column lands. The column is in board
// order; `index` counts the column's other tasks above the drop. Neighbors
// must share the task's project and the target status, so tasks of other
// projects or statuses in the same column are skipped.
export function dropNeighbors(
  column: readonly PlacedTask[],
  task: PlacedTask,
  index: number,
  status: string,
): Neighbors {
  const rest = column.filter((t) => t.id !== task.id);
  const fits = (t: PlacedTask) =>
    t.projectId === task.projectId && t.status === status;
  const above = rest.slice(0, index).filter(fits);
  const below = rest.slice(index).filter(fits);
  return {
    beforeTaskId: above.at(-1)?.id ?? null,
    afterTaskId: below[0]?.id ?? null,
  };
}

// The drop index for a pointer at `y`: how many cards' middles lie above it.
export function dropIndex(
  y: number,
  cards: readonly { y: number; height: number }[],
): number {
  return cards.filter((card) => card.y + card.height / 2 < y).length;
}

export function columnAt<Key>(
  x: number,
  columns: readonly { key: Key; x: number; width: number }[],
): Key | null {
  return (
    columns.find((column) => x >= column.x && x < column.x + column.width)
      ?.key ?? null
  );
}

// One line of an agent comment for a card: its first line without markdown
// heading or list markers.
export function agentExcerpt(note: string | null): string | null {
  if (!note) return null;
  const line = note
    .split("\n")
    .map((l) => l.replace(/^\s*(?:#+|[-*>]|\d+\.)\s+/, "").trim())
    .find((l) => l.length > 0);
  return line ?? null;
}
