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
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } } as unknown as Storage;
    const state = createSeedWorkspace();
    expect(saveWorkspace(state, storage)).toBe(true);
    expect(values.has(STORAGE_KEY)).toBe(true);
    expect(loadWorkspace(storage).project.title).toBe(state.project.title);
    clearWorkspace(storage);
    expect(values.has(STORAGE_KEY)).toBe(false);
  });
  it('loads legacy workspaces saved before checklist handoffs existed', () => {
    const legacy = JSON.parse(JSON.stringify(createSeedWorkspace())) as Record<string, unknown>;
    delete legacy.checklistHandoffs;
    const storage = { getItem: () => JSON.stringify(legacy) } as unknown as Storage;
    const loaded = loadWorkspace(storage);
    expect(loaded.project.title).toBe('Afterlight: Material Memory');
    expect(loaded.zones.find((zone) => zone.id === 'zone-common')?.artifactIds).toEqual(['artifact-press', 'artifact-quilt']);
    expect(loaded.checklistHandoffs).toEqual([]);
  });
  it('round trips recorded handoffs through storage', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } } as unknown as Storage;
    const state = createSeedWorkspace();
    const withHandoff = {
      ...state,
      checklistHandoffs: [{
        id: 'handoff-test',
        zoneId: 'zone-common',
        version: 1,
        createdAt: '2026-09-12T09:00:00.000Z',
        scope: 'Floor install crew',
        members: ['Jo Renner'],
        readinessBasis: { stage: 'review' as const, ready: false, score: 64, blockers: ['1 critical review finding remains unresolved.'], cautions: [], checkedAt: '2026-09-12T09:00:00.000Z' },
        summary: { objectCount: 2, totalDwellMinutes: 15, unresolvedCount: 0, digest: 'abcd1234' },
        checklist: { zoneId: 'zone-common', zoneName: 'The Common Thread', zoneShortLabel: 'Common Thread', thesis: 'Objects become civic tools when communities make meaning together.', projectTitle: state.project.title, venue: state.project.venue, generatedAt: '2026-09-12T09:00:00.000Z', totalDwellMinutes: 15, objectCount: 2, unresolvedCount: 0, zoneFindings: [], entries: [] },
      }],
    };
    expect(saveWorkspace(withHandoff, storage)).toBe(true);
    const loaded = loadWorkspace(storage);
    expect(loaded.checklistHandoffs).toHaveLength(1);
    expect(loaded.checklistHandoffs[0].scope).toBe('Floor install crew');
    expect(loaded.checklistHandoffs[0].summary.digest).toBe('abcd1234');
  });
});
