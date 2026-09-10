import { HISTORY_LIMIT, normalizeHistory, type HistoryEntry } from '../domain/commandLog';

/**
 * Operation history is intentionally stored under its own key. It never shares
 * the workspace document, so a reset or a corrupted workspace cannot erase the
 * audit trail, and history logic can never overwrite business state.
 */
export const ACTIVITY_HISTORY_KEY = 'exhibit-flow.activity-history.v1';

export function loadActivityHistory(storage: Pick<Storage, 'getItem'> = localStorage): HistoryEntry[] {
  try {
    const raw = storage.getItem(ACTIVITY_HISTORY_KEY);
    if (!raw) return [];
    return normalizeHistory(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function saveActivityHistory(entries: HistoryEntry[], storage: Pick<Storage, 'setItem'> = localStorage): boolean {
  try {
    storage.setItem(ACTIVITY_HISTORY_KEY, JSON.stringify(entries.slice(-HISTORY_LIMIT)));
    return true;
  } catch {
    return false;
  }
}

export function clearActivityHistory(storage: Pick<Storage, 'removeItem'> = localStorage): void {
  try {
    storage.removeItem(ACTIVITY_HISTORY_KEY);
  } catch {
    // History is diagnostic; a storage error must not break the workspace.
  }
}
