import { describe, expect, it } from 'vitest';
import { clearWorkspace, loadWorkspace, saveWorkspace, STORAGE_KEY, assertUsable } from './persistence';
import { createSeedWorkspace } from './seed';
import { RESTORE_BACKUP_KEY } from './restore';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(initial));
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } as unknown as Storage,
  };
}

describe('workspace persistence', () => {
  it('falls back to seed state for malformed storage', () => {
    const { storage } = memoryStorage({ [STORAGE_KEY]: '{bad json' });
    const result = loadWorkspace({ storage });
    expect(result.state.version).toBe(2);
    expect(result.fellBackToSeed).toBe(true);
  });

  it('round trips a workspace through storage', () => {
    const { values, storage } = memoryStorage();
    const state = createSeedWorkspace();
    expect(saveWorkspace(state, storage)).toBe(true);
    expect(values.has(STORAGE_KEY)).toBe(true);
    expect(loadWorkspace({ storage }).state.project.title).toBe(state.project.title);
    clearWorkspace(storage);
    expect(values.has(STORAGE_KEY)).toBe(false);
  });

  it('migrates a legacy (version 0, no sequence) workspace exactly as before', () => {
    const seed = createSeedWorkspace();
    const legacy = {
      project: seed.project,
      artifacts: seed.artifacts,
      zones: seed.zones.map(({ sequence: _sequence, ...zone }) => zone),
      issues: seed.issues,
      preferences: { pace: 'balanced', accessibilityPriority: 70, groupSize: 6 },
    };
    const { storage } = memoryStorage({ [STORAGE_KEY]: JSON.stringify(legacy) });
    const result = loadWorkspace({ storage });
    expect(result.state.version).toBe(2);
    expect(result.state.zones.map((zone) => zone.sequence)).toEqual([0, 1, 2, 3]);
    // Old read behavior: dangling references are silently pruned.
    expect(result.state.preferences.transitionBufferMinutes).toBe(3);
  });

  it('silently prunes dangling references on the automatic load path', () => {
    const seed = createSeedWorkspace();
    const withDangling: unknown = {
      ...seed,
      version: 2,
      zones: seed.zones.map((zone, index) => index === 0 ? { ...zone, artifactIds: [...zone.artifactIds, 'artifact-gone'] } : zone),
      issues: [...seed.issues, { ...seed.issues[0], id: 'issue-dangling', zoneId: 'zone-gone', artifactId: 'artifact-gone' }],
    };
    const { storage } = memoryStorage({ [STORAGE_KEY]: JSON.stringify(withDangling) });
    const result = loadWorkspace({ storage });
    expect(result.state.zones[0].artifactIds).not.toContain('artifact-gone');
    const issue = result.state.issues.find((entry) => entry.id === 'issue-dangling');
    expect(issue?.zoneId).toBeUndefined();
    expect(issue?.artifactId).toBeUndefined();
  });

  it('rolls an interrupted restore back to the previous workspace on next load', () => {
    const previous = createSeedWorkspace();
    const { values, storage } = memoryStorage({
      [STORAGE_KEY]: JSON.stringify({ ...previous, project: { ...previous.project, title: 'HALF WRITTEN TITLE' } }),
      [RESTORE_BACKUP_KEY]: JSON.stringify({ savedAt: '2026-09-11T10:00:00.000Z', serialized: JSON.stringify(previous) }),
    });
    const result = loadWorkspace({ storage });
    expect(result.recoveredFromInterruption).toBe(true);
    expect(result.state.project.title).toBe(previous.project.title);
    expect(values.has(RESTORE_BACKUP_KEY)).toBe(false);
  });

  it('rolls an interrupted first-time restore back to empty storage', () => {
    const { values, storage } = memoryStorage({
      [STORAGE_KEY]: JSON.stringify(createSeedWorkspace()),
      [RESTORE_BACKUP_KEY]: JSON.stringify({ savedAt: '2026-09-11T10:00:00.000Z', serialized: null }),
    });
    const result = loadWorkspace({ storage });
    expect(result.recoveredFromInterruption).toBe(true);
    expect(values.has(STORAGE_KEY)).toBe(false);
  });

  it('validates the sample plan through the shared structural path', () => {
    expect(() => assertUsable(createSeedWorkspace())).not.toThrow();
    const state = assertUsable(createSeedWorkspace());
    expect(state.version).toBe(2);
  });
});
