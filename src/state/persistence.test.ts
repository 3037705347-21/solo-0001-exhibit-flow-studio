import { describe, expect, it } from 'vitest';
import { clearWorkspace, loadWorkspace, saveWorkspace, STORAGE_KEY } from './persistence';
import { migrateWorkspace } from './migrations';
import { createSeedWorkspace } from './seed';

describe('workspace persistence', () => {
  it('falls back to seed state for malformed storage', () => {
    const storage = { getItem: () => '{bad json' } as unknown as Storage;
    expect(loadWorkspace(storage).version).toBe(1);
  });
  it('round trips a workspace through storage', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } } as unknown as Storage;
    const state = createSeedWorkspace();
    expect(saveWorkspace(state, storage)).toBe(true);
    expect(values.has(STORAGE_KEY)).toBe(true);
    expect(loadWorkspace(storage).project.title).toBe(state.project.title);
    clearWorkspace(storage);
    expect(values.has(STORAGE_KEY)).toBe(false);
  });
  it('persists held removals and publications across reloads', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } } as unknown as Storage;
    const state = createSeedWorkspace();
    const withRecords = {
      ...state,
      removals: [{ id: 'removal-1', artifactId: 'artifact-quilt', artifactVersion: 'v', zoneId: 'zone-common', zoneVersion: 'z', index: 1, neighborBeforeId: 'artifact-press', neighborAfterId: null, zoneOrderAfterRemoval: ['artifact-press'], relatedFindings: [], exportDependencies: [], status: 'held' as const, createdAt: '2026-09-10T10:00:00.000Z', reviewAttempts: 0 }],
      publications: [{ generatedAt: '2026-09-01T10:00:00.000Z', fileName: 'snapshot.json', readinessScore: 90, zoneIds: ['zone-common'], artifactIds: ['artifact-press'] }],
    };
    saveWorkspace(withRecords, storage);
    const reloaded = loadWorkspace(storage);
    expect(reloaded.removals).toHaveLength(1);
    expect(reloaded.publications).toHaveLength(1);
  });
  it('migrates workspaces saved before recovery records existed', () => {
    const legacy = createSeedWorkspace() as unknown as Record<string, unknown>;
    delete legacy.removals;
    delete legacy.publications;
    const migrated = migrateWorkspace(legacy);
    expect(migrated?.removals).toEqual([]);
    expect(migrated?.publications).toEqual([]);
  });
});
