import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceState } from '../domain/models';
import { createAllocationDraft, setDraftTarget } from '../domain/workload';
import { STORAGE_KEY } from './persistence';
import { createSeedWorkspace } from './seed';
import { WorkspaceProvider, useWorkspace, type AllocationCommandResult } from './WorkspaceContext';

interface TestLockManager {
  held: () => boolean;
  request: (name: string, callback: () => Promise<void> | void) => Promise<void>;
}

function makeLockManager(): TestLockManager {
  let active = 0;
  return {
    held: () => active > 0,
    request: async (_name: string, callback: () => Promise<void> | void) => {
      active += 1;
      try {
        await callback();
      } finally {
        active -= 1;
      }
    },
  };
}

function seededStorage(overrides?: (state: WorkspaceState) => WorkspaceState): Storage {
  const state = overrides ? overrides(createSeedWorkspace()) : createSeedWorkspace();
  const store = new Map<string, string>([[STORAGE_KEY, JSON.stringify(state)]]);
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() { return store.size; },
  } as unknown as Storage;
}

function renderWorkspace(storage: Storage, locks: TestLockManager | null) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { ...globalThis.navigator, locks: locks ?? undefined },
    configurable: true,
    writable: true,
  });
  vi.stubGlobal('localStorage', storage);
  const wrapper = ({ children }: { children: ReactNode }) => <WorkspaceProvider>{children}</WorkspaceProvider>;
  return renderHook(() => useWorkspace(), { wrapper });
}

async function commit(result: { current: ReturnType<typeof useWorkspace> }, plan: ReturnType<typeof createAllocationDraft>): Promise<AllocationCommandResult> {
  let response!: AllocationCommandResult;
  await act(async () => {
    response = await result.current.commitAllocationPlan(plan);
  });
  return response;
}

describe('commitAllocationPlan cross-tab atomicity', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('re-reads shared state under the lock and rejects the whole batch when a peer changed a finding', async () => {
    const storage = seededStorage();
    const locks = makeLockManager();
    const { result } = renderWorkspace(storage, locks);

    const draft = setDraftTarget(
      createAllocationDraft(result.current.state.issues, ['issue-entry-copy']),
      'issue-entry-copy',
      'Mara Chen',
    );

    // Peer writes while the dialog is open: same finding moves to in-progress.
    const peer = JSON.parse(storage.getItem(STORAGE_KEY)!) as WorkspaceState;
    const drifted: WorkspaceState = {
      ...peer,
      issues: peer.issues.map((issue) =>
        issue.id === 'issue-entry-copy'
          ? { ...issue, status: 'in-progress', version: issue.version + 1, updatedAt: '2026-09-11T00:00:00.000Z' }
          : issue),
      lastSavedAt: '2026-09-11T00:00:00.000Z',
    };
    storage.setItem(STORAGE_KEY, JSON.stringify(drifted));

    const response = await commit(result, draft);
    expect(response.ok).toBe(false);
    expect(response.conflicts?.some((conflict) => conflict.issueId === 'issue-entry-copy' && conflict.type === 'status-changed')).toBe(true);
    // No partial application in storage or in memory.
    const storedAfter = JSON.parse(storage.getItem(STORAGE_KEY)!) as WorkspaceState;
    expect(storedAfter.issues.find((issue) => issue.id === 'issue-entry-copy')!.owner).toBe('Theo James');
    expect(result.current.state.issues.find((issue) => issue.id === 'issue-entry-copy')!.owner).toBe('Theo James');
    expect(storedAfter.assignmentLog).toEqual([]);
  });

  it('commits issues and the complete audit entry in a single storage write', async () => {
    const storage = seededStorage();
    const writes: string[] = [];
    const rawSet = storage.setItem.bind(storage);
    const { result } = renderWorkspace(storage, makeLockManager());

    const draft = setDraftTarget(
      createAllocationDraft(result.current.state.issues, ['issue-entry-copy']),
      'issue-entry-copy',
      'Rina Solberg',
    );
    storage.setItem = (key: string, value: string) => { writes.push(key); rawSet(key, value); };
    const response = await commit(result, draft);

    expect(response.ok).toBe(true);
    expect(response.audit).toHaveLength(1);
    expect(writes.filter((key) => key === STORAGE_KEY)).toHaveLength(1);

    const storedAfter = JSON.parse(storage.getItem(STORAGE_KEY)!) as WorkspaceState;
    const moved = storedAfter.issues.find((issue) => issue.id === 'issue-entry-copy')!;
    expect(moved.owner).toBe('Rina Solberg');
    expect(moved.version).toBe(1);
    expect(moved.status).toBe('open');
    expect(storedAfter.assignmentLog).toHaveLength(1);
    expect(storedAfter.assignmentLog[0]).toMatchObject({ planId: draft.planId, toOwner: 'Rina Solberg' });
  });

  it('recognizes the same plan id already committed by another tab as a duplicate', async () => {
    const storage = seededStorage();
    const { result } = renderWorkspace(storage, makeLockManager());
    const draft = setDraftTarget(
      createAllocationDraft(result.current.state.issues, ['issue-entry-copy']),
      'issue-entry-copy',
      'Mara Chen',
    );

    // Another tab committed this exact plan id first.
    const peer = JSON.parse(storage.getItem(STORAGE_KEY)!) as WorkspaceState;
    storage.setItem(STORAGE_KEY, JSON.stringify({
      ...peer,
      issues: peer.issues.map((issue) =>
        issue.id === 'issue-entry-copy' ? { ...issue, owner: 'Mara Chen', version: 1 } : issue),
      assignmentLog: [{
        id: 'audit-issue-entry-copy-0',
        planId: draft.planId,
        issueId: 'issue-entry-copy',
        issueTitle: 'Reduce entry panel copy',
        fromOwner: 'Theo James',
        toOwner: 'Mara Chen',
        fromStatus: 'open',
        toStatus: 'open',
        timestamp: '2026-09-11T00:00:00.000Z',
      }],
      lastSavedAt: '2026-09-11T00:00:00.000Z',
    } satisfies WorkspaceState));

    const writeCountBefore = (storage.getItem(STORAGE_KEY)?.length ?? 0);
    const response = await commit(result, draft);
    expect(response.ok).toBe(true);
    expect(response.duplicate).toBe(true);
    // The duplicate must not trigger another storage write.
    expect(storage.getItem(STORAGE_KEY)?.length).toBe(writeCountBefore);
  });

  it('still rejects drift through version checks when the LockManager API is unavailable', async () => {
    const storage = seededStorage();
    const { result } = renderWorkspace(storage, null);
    const draft = setDraftTarget(
      createAllocationDraft(result.current.state.issues, ['issue-entry-copy']),
      'issue-entry-copy',
      'Mara Chen',
    );
    const peer = JSON.parse(storage.getItem(STORAGE_KEY)!) as WorkspaceState;
    storage.setItem(STORAGE_KEY, JSON.stringify({
      ...peer,
      issues: peer.issues.map((issue) =>
        issue.id === 'issue-entry-copy' ? { ...issue, owner: 'Rina Solberg', version: 7 } : issue),
    } satisfies WorkspaceState));
    const response = await commit(result, draft);
    expect(response.ok).toBe(false);
    expect(response.conflicts?.[0].type).toBe('owner-changed');
  });
});
