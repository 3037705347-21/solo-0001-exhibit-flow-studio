import type { WorkspaceState } from '../domain/models';

export interface WorkspaceHistory {
  past: WorkspaceState[];
  present: WorkspaceState;
  future: WorkspaceState[];
  limit: number;
}

export function createHistory(initial: WorkspaceState, limit = 30): WorkspaceHistory {
  return { past: [], present: initial, future: [], limit };
}

export function pushHistory(history: WorkspaceHistory, next: WorkspaceState): WorkspaceHistory {
  if (history.present === next) return history;
  return {
    ...history,
    past: [...history.past, history.present].slice(-history.limit),
    present: next,
    future: [],
  };
}

export function undoHistory(history: WorkspaceHistory): WorkspaceHistory {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    ...history,
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future].slice(0, history.limit),
  };
}

export function redoHistory(history: WorkspaceHistory): WorkspaceHistory {
  const next = history.future[0];
  if (!next) return history;
  return {
    ...history,
    past: [...history.past, history.present].slice(-history.limit),
    present: next,
    future: history.future.slice(1),
  };
}

export function canUndo(history: WorkspaceHistory): boolean {
  return history.past.length > 0;
}
export function canRedo(history: WorkspaceHistory): boolean {
  return history.future.length > 0;
}
