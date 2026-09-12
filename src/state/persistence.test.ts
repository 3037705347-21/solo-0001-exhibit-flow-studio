import { describe, expect, it } from 'vitest';
import { clearWorkspace, loadWorkspace, saveWorkspace, STORAGE_KEY } from './persistence';
import { createSeedWorkspace } from './seed';

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
    const storage = { getItem: () => '{bad json' } as unknown as Storage;
    expect(loadWorkspace(storage).version).toBe(1);
  });
  it('round trips a workspace through storage', () => {
    const { values, storage } = memoryStorage();
    const state = createSeedWorkspace();
    expect(saveWorkspace(state, storage)).toBe(true);
    expect(values.has(STORAGE_KEY)).toBe(true);
    expect(loadWorkspace(storage).project.title).toBe(state.project.title);
    clearWorkspace(storage);
    expect(values.has(STORAGE_KEY)).toBe(false);
  });
  it('preserves the full revision history across a reload', () => {
    const { storage } = memoryStorage();
    const state = createSeedWorkspace();
    const extra = {
      id: 'rev-extra',
      issueId: 'issue-entry-copy',
      kind: 'edit' as const,
      baseVersion: 1,
      resultVersion: 2,
      editor: 'Jo Renner',
      rationale: 'Scope confirmed with the curator.',
      changes: [{ field: 'title' as const, before: 'Reduce entry panel copy', after: 'Shorten entry panel copy' }],
      committedAt: '2026-09-12T09:00:00.000Z',
    };
    const dirty = {
      ...state,
      issues: state.issues.map((issue) => issue.id === 'issue-entry-copy' ? { ...issue, title: 'Shorten entry panel copy', version: 2 } : issue),
      issueHistory: [...state.issueHistory, extra],
    };
    saveWorkspace(dirty, storage);
    const restored = loadWorkspace(storage);
    expect(restored.issueHistory).toEqual(dirty.issueHistory);
    expect(restored.issueHistory.filter((revision) => revision.issueId === 'issue-entry-copy')).toHaveLength(2);
    expect(restored.issues.find((issue) => issue.id === 'issue-entry-copy')?.version).toBe(2);
  });
  it('migrates legacy workspaces that predate versions and history', () => {
    const legacy = JSON.parse(JSON.stringify(createSeedWorkspace())) as Record<string, unknown>;
    delete legacy.issueHistory;
    for (const issue of legacy.issues as Array<Record<string, unknown>>) delete issue.version;
    const { storage } = memoryStorage({ [STORAGE_KEY]: JSON.stringify(legacy) });
    const restored = loadWorkspace(storage);
    expect(restored.issueHistory).toEqual([]);
    expect(restored.issues.every((issue) => issue.version === 1)).toBe(true);
    expect(restored.issues.find((issue) => issue.id === 'issue-entry-copy')?.title).toBe('Reduce entry panel copy');
  });
});
