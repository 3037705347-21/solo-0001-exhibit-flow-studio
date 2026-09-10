import { describe, expect, it } from 'vitest';
import { ACTIVITY_HISTORY_KEY, clearActivityHistory, loadActivityHistory, saveActivityHistory } from './activityHistory';
import { createHistoryEntry, HISTORY_LIMIT, type HistoryEntry } from '../domain/commandLog';
import { createSeedWorkspace } from './seed';

const seed = createSeedWorkspace();

function memoryStore(initial: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(initial));
  return {
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } as unknown as Storage,
    values,
  };
}

function fakeEntry(id: string): HistoryEntry {
  return createHistoryEntry({ type: 'workspace/reset', state: seed }, { artifacts: seed.artifacts, zones: seed.zones, issues: seed.issues, preferences: seed.preferences }, id);
}

describe('activity history persistence', () => {
  it('starts empty when nothing is stored', () => {
    expect(loadActivityHistory(memoryStore().storage)).toEqual([]);
  });

  it('falls back to an empty list for malformed storage', () => {
    expect(loadActivityHistory(memoryStore({ [ACTIVITY_HISTORY_KEY]: '{bad json' }).storage)).toEqual([]);
  });

  it('round trips entries independently of the workspace key', () => {
    const { storage, values } = memoryStore();
    saveActivityHistory([fakeEntry('event-1')], storage);
    expect(values.has('exhibit-flow.workspace.v1')).toBe(false);
    expect(values.has(ACTIVITY_HISTORY_KEY)).toBe(true);
    const loaded = loadActivityHistory(storage);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('event-1');
  });

  it('caps persisted entries to the history limit', () => {
    const { storage } = memoryStore();
    const entries = Array.from({ length: HISTORY_LIMIT + 20 }, (_, index) => fakeEntry(`event-${index}`));
    saveActivityHistory(entries, storage);
    const loaded = loadActivityHistory(storage);
    expect(loaded).toHaveLength(HISTORY_LIMIT);
    expect(loaded[0].id).toBe('event-20');
    expect(loaded[loaded.length - 1].id).toBe(`event-${HISTORY_LIMIT + 19}`);
  });

  it('clears only the history key', () => {
    const { storage, values } = memoryStore();
    values.set('exhibit-flow.workspace.v1', '{}');
    saveActivityHistory([fakeEntry('event-1')], storage);
    clearActivityHistory(storage);
    expect(values.has(ACTIVITY_HISTORY_KEY)).toBe(false);
    expect(values.has('exhibit-flow.workspace.v1')).toBe(true);
  });

  it('reports save failure without throwing when storage throws', () => {
    const storage = { setItem: () => { throw new Error('quota'); } } as unknown as Storage;
    expect(saveActivityHistory([fakeEntry('event-1')], storage)).toBe(false);
  });
});
