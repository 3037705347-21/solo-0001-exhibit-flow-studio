import { describe, expect, it } from 'vitest';
import { clearWorkspace, loadWorkspace, replaceWorkspace, rollbackWorkspace, saveWorkspace, STORAGE_KEY } from './persistence';
import { createSeedWorkspace } from './seed';
import type { WorkspaceState } from '../domain/models';

function mapStorage(initial = new Map<string, string>()) {
  const values = initial;
  return {
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } as unknown as Storage,
    values,
  };
}

describe('workspace persistence', () => {
  it('falls back to seed state for malformed storage', () => {
    const storage = { getItem: () => '{bad json' } as unknown as Storage;
    expect(loadWorkspace(storage).version).toBe(2);
  });
  it('round trips a workspace through storage', () => {
    const { storage, values } = mapStorage();
    const state = createSeedWorkspace();
    expect(saveWorkspace(state, storage)).toBe(true);
    expect(values.has(STORAGE_KEY)).toBe(true);
    expect(loadWorkspace(storage).project.title).toBe(state.project.title);
    clearWorkspace(storage);
    expect(values.has(STORAGE_KEY)).toBe(false);
  });
  it('silently migrates a stored v1 workspace without regressing read behavior', () => {
    const v1: WorkspaceState = { ...createSeedWorkspace(), version: 1 as unknown as 2 };
    const { storage } = mapStorage(new Map([[STORAGE_KEY, JSON.stringify(v1)]]));
    const loaded = loadWorkspace(storage);
    expect(loaded.version).toBe(2);
    expect(loaded.project.planCode).toBeTruthy();
    expect(loaded.preferences.targetVisitMinutes).toBeNull();
    expect(loaded.artifacts.length).toBe(v1.artifacts.length);
    expect(loaded.zones.map((zone) => zone.sequence)).toEqual(v1.zones.map((zone) => zone.sequence));
  });
  it('returns seed state when the stored document is a readiness snapshot', () => {
    const snapshot = { schemaVersion: 1, project: { id: 'x' } };
    const { storage } = mapStorage(new Map([[STORAGE_KEY, JSON.stringify(snapshot)]]));
    expect(loadWorkspace(storage).project.id).toBe('project-afterlight');
  });
  it('rejects an invalid candidate before touching storage and rolls a failed write back', () => {
    const original = JSON.stringify(createSeedWorkspace());
    const values = new Map([[STORAGE_KEY, original]]);
    const failingStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (value !== original) throw new Error('quota exceeded');
        values.set(key, value);
      },
      removeItem: (key: string) => { values.delete(key); },
    } as unknown as Storage;

    const recovered: WorkspaceState = {
      ...createSeedWorkspace(),
      project: { ...createSeedWorkspace().project, title: 'Recovered exhibition' },
    };
    // The failure only triggers for a genuinely new write; rollback writes
    // the exact original bytes and must still succeed.
    const result = replaceWorkspace(recovered, failingStorage);
    expect(result.ok).toBe(false);
    expect(values.get(STORAGE_KEY)).toBe(original);
    expect(loadWorkspace(failingStorage).project.id).toBe('project-afterlight');
  });
  it('rolls a committed recovery back to the exact previous bytes', () => {
    const original = JSON.stringify(createSeedWorkspace());
    const { storage, values } = mapStorage(new Map([[STORAGE_KEY, original]]));
    const recovered: WorkspaceState = {
      ...createSeedWorkspace(),
      project: { ...createSeedWorkspace().project, title: 'Recovered exhibition' },
    };
    const write = replaceWorkspace(recovered, storage);
    expect(write.ok).toBe(true);
    expect(loadWorkspace(storage).project.title).toBe('Recovered exhibition');
    expect(rollbackWorkspace(write.previous, storage)).toBe(true);
    expect(values.get(STORAGE_KEY)).toBe(original);
  });
});
