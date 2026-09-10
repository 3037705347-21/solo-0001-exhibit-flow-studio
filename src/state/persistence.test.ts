import { describe, expect, it } from 'vitest';
import { clearWorkspace, loadWorkspace, saveWorkspace, STORAGE_KEY } from './persistence';
import { createSeedWorkspace } from './seed';

describe('workspace persistence', () => {
  it('falls back to seed state for malformed storage', () => {
    const storage = { getItem: () => '{bad json' } as unknown as Storage;
    expect(loadWorkspace(storage).version).toBe(1);
  });
  it('round trips a workspace through storage', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    } as unknown as Storage;
    const state = createSeedWorkspace();
    expect(saveWorkspace(state, storage)).toBe(true);
    expect(values.has(STORAGE_KEY)).toBe(true);
    expect(loadWorkspace(storage).project.title).toBe(state.project.title);
    clearWorkspace(storage);
    expect(values.has(STORAGE_KEY)).toBe(false);
  });
});
