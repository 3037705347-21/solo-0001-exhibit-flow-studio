import { describe, expect, it } from 'vitest';
import type { AssignmentAuditEntry } from '../domain/models';
import { createAllocationDraft, setDraftTarget } from '../domain/workload';
import { workspaceReducer } from './reducer';
import { createSeedWorkspace } from './seed';

describe('issues/reassignBatch reducer', () => {
  it('commits the batch through the write boundary', () => {
    const state = createSeedWorkspace();
    const draft = setDraftTarget(createAllocationDraft(state.issues, ['issue-entry-copy']), 'issue-entry-copy', 'Mara Chen');
    const next = workspaceReducer(state, { type: 'issues/reassignBatch', plan: draft });
    const moved = next.issues.find((issue) => issue.id === 'issue-entry-copy')!;
    expect(moved.owner).toBe('Mara Chen');
    expect(moved.version).toBe(1);
    expect(next.assignmentLog).toHaveLength(1);
    expect(next.lastSavedAt).toBeTruthy();
  });

  it('leaves state untouched when a finding version no longer matches', () => {
    const state = createSeedWorkspace();
    const draft = setDraftTarget(createAllocationDraft(state.issues, ['issue-entry-copy']), 'issue-entry-copy', 'Mara Chen');
    // Simulate an external status change bumping the version after the batch opened.
    const drifted: typeof state = {
      ...state,
      issues: state.issues.map((issue) =>
        issue.id === 'issue-entry-copy' ? { ...issue, status: 'in-progress' as const, version: issue.version + 1 } : issue),
    };
    const next = workspaceReducer(drifted, { type: 'issues/reassignBatch', plan: draft });
    expect(next).toBe(drifted);
    const stillOpen = drifted.issues.find((issue) => issue.id === 'issue-entry-copy')!;
    expect(stillOpen.owner).toBe('Theo James');
  });

  it('treats a repeated plan dispatch as a no-op so duplicate confirms never double-allocate', () => {
    const state = createSeedWorkspace();
    const draft = setDraftTarget(createAllocationDraft(state.issues, ['issue-entry-copy']), 'issue-entry-copy', 'Mara Chen');
    const once = workspaceReducer(state, { type: 'issues/reassignBatch', plan: draft });
    expect(once.assignmentLog).toHaveLength(1);
    const twice = workspaceReducer(once, { type: 'issues/reassignBatch', plan: draft });
    expect(twice).toBe(once);
  });
});

describe('workspace/syncExternal reducer', () => {
  it('adopts external state and merges unknown audit entries without duplication', () => {
    const local = createSeedWorkspace();
    const external = createSeedWorkspace();
    const externalAudit: AssignmentAuditEntry = {
      id: 'audit-issue-entry-copy-0',
      planId: 'plan-peer',
      issueId: 'issue-entry-copy',
      issueTitle: 'Reduce entry panel copy',
      fromOwner: 'Theo James',
      toOwner: 'Rina Solberg',
      fromStatus: 'open',
      toStatus: 'open',
      timestamp: '2026-09-10T12:00:00.000Z',
    };
    const externalState = {
      ...external,
      issues: external.issues.map((issue) =>
        issue.id === 'issue-entry-copy' ? { ...issue, owner: 'Rina Solberg', version: 1 } : issue),
      assignmentLog: [externalAudit],
    };
    const synced = workspaceReducer(local, { type: 'workspace/syncExternal', state: externalState, audit: [externalAudit] });
    expect(synced.issues.find((issue) => issue.id === 'issue-entry-copy')!.owner).toBe('Rina Solberg');
    expect(synced.assignmentLog).toHaveLength(1);
    // The external save timestamp is retained, preventing storage-event ping-pong.
    expect(synced.lastSavedAt).toBe(externalState.lastSavedAt);
    // A second sync carrying the same audit id must not duplicate the entry.
    const resynced = workspaceReducer(synced, { type: 'workspace/syncExternal', state: externalState, audit: [externalAudit] });
    expect(resynced.assignmentLog).toHaveLength(1);
  });
});
