import { describe, expect, it } from 'vitest';
import { canPublish, canSignOff } from '../domain/approval';
import { clearWorkspace, loadWorkspace, saveWorkspace, STORAGE_KEY } from './persistence';
import { createSeedWorkspace } from './seed';

function memoryStorage(initial?: Record<string, string>) {
  const values = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    has: (key: string) => values.has(key),
  } as unknown as Storage & { has: (key: string) => boolean };
}

describe('workspace persistence', () => {
  it('falls back to seed state for malformed storage', () => {
    const storage = { getItem: () => '{bad json' } as unknown as Storage;
    expect(loadWorkspace(storage).version).toBe(1);
  });
  it('round trips a workspace through storage', () => {
    const storage = memoryStorage();
    const state = createSeedWorkspace();
    expect(saveWorkspace(state, storage)).toBe(true);
    expect(storage.has(STORAGE_KEY)).toBe(true);
    expect(loadWorkspace(storage).project.title).toBe(state.project.title);
    clearWorkspace(storage);
    expect(storage.has(STORAGE_KEY)).toBe(false);
  });
});

describe('sign-off migration', () => {
  it('keeps a legacy ready project ready but never invents a sign-off', () => {
    const legacy = createSeedWorkspace();
    const legacyReady = { ...legacy, project: { ...legacy.project, stage: 'ready' as const } };
    // A workspace saved before the sign-off policy has no approval field at all.
    expect('approval' in legacyReady).toBe(false);
    const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify(legacyReady) });
    const loaded = loadWorkspace(storage);
    expect(loaded.project.stage).toBe('ready');
    expect(loaded.approval).toBeUndefined();
    // Publishing stays locked until a real lead confirms the migrated plan.
    expect(canPublish(loaded).ok).toBe(false);
  });

  it('lets a migrated ready project be signed off once readiness genuinely passes', () => {
    const legacy = createSeedWorkspace();
    const legacyReady = {
      ...legacy,
      project: { ...legacy.project, stage: 'ready' as const },
      issues: legacy.issues.map((issue) => issue.severity === 'critical' ? { ...issue, status: 'resolved' as const } : issue),
    };
    const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify(legacyReady) });
    const loaded = loadWorkspace(storage);
    expect(canSignOff(loaded).ok).toBe(true);
  });

  it('preserves a well-formed sign-off and drops a malformed one', () => {
    const base = createSeedWorkspace();
    const approval = { approver: 'Mara Chen', approvedAt: '2026-09-10T09:00:00.000Z', planVersion: 'plan-deadbeef', status: 'active' as const };
    const withApproval = memoryStorage({ [STORAGE_KEY]: JSON.stringify({ ...base, approval }) });
    expect(loadWorkspace(withApproval).approval).toEqual(approval);
    const malformed = memoryStorage({ [STORAGE_KEY]: JSON.stringify({ ...base, approval: 'signed-off' }) });
    expect(loadWorkspace(malformed).approval).toBeUndefined();
  });
});
