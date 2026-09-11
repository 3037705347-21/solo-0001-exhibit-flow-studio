import { describe, expect, it } from 'vitest';
import {
  clearWorkspace,
  loadWorkspaceWithRecovery,
  saveWorkspace,
  STORAGE_KEY,
  SNAPSHOT_KEYS,
  COMMAND_LOG_KEY,
} from './persistence';
import { createSeedWorkspace } from './seed';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => { values.clear(); },
    key: (index: number) => [...values.keys()][index] ?? null,
    length: values.size,
  } as unknown as Storage;
}

describe('workspace persistence facade', () => {
  it('falls back to seed state for malformed storage', () => {
    const storage = memoryStorage({ [STORAGE_KEY]: '{bad json' });
    expect(loadWorkspaceWithRecovery(storage).state.version).toBe(1);
  });

  it('round trips a workspace through a verified snapshot', () => {
    const storage = memoryStorage();
    const state = createSeedWorkspace();
    expect(saveWorkspace(state, storage)).toBe(true);
    expect(SNAPSHOT_KEYS.some((key) => storage.getItem(key) !== null)).toBe(true);
    expect(loadWorkspaceWithRecovery(storage).state.project.title).toBe(state.project.title);
    clearWorkspace(storage);
    expect(SNAPSHOT_KEYS.every((key) => storage.getItem(key) === null)).toBe(true);
    expect(storage.getItem(COMMAND_LOG_KEY)).toBe(null);
  });

  it('migrates a legacy bare-state object on first recovery boot', () => {
    const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify(createSeedWorkspace()) });
    const loaded = loadWorkspaceWithRecovery(storage);
    expect(loaded.report.base).toBe('legacy');
    // Second boot is snapshot-based.
    expect(loadWorkspaceWithRecovery(storage).report.base).toBe('snapshot');
  });
});
