import { describe, expect, it } from 'vitest';
import type { AssignmentAuditEntry, WorkspaceState } from '../domain/models';
import { workspaceReducer } from './reducer';
import { createSeedWorkspace } from './seed';

describe('allocation/committed reducer', () => {
  it('adopts the authoritative state produced by the locked transaction without re-stamping', () => {
    const state = createSeedWorkspace();
    const committed: WorkspaceState = {
      ...state,
      issues: state.issues.map((issue) =>
        issue.id === 'issue-entry-copy' ? { ...issue, owner: 'Mara Chen', version: 1 } : issue),
      assignmentLog: [{
        id: 'audit-issue-entry-copy-0',
        planId: 'plan-1',
        issueId: 'issue-entry-copy',
        issueTitle: 'Reduce entry panel copy',
        fromOwner: 'Theo James',
        toOwner: 'Mara Chen',
        fromStatus: 'open',
        toStatus: 'open',
        timestamp: '2026-09-10T12:00:00.000Z',
      }],
      lastSavedAt: '2026-09-10T12:00:00.000Z',
    };
    const next = workspaceReducer(state, { type: 'allocation/committed', state: committed, movedCount: 1, duplicate: false });
    expect(next).toBe(committed);
  });

  it('does not mutate state on a duplicate confirmation marker', () => {
    const state = createSeedWorkspace();
    const next = workspaceReducer(state, { type: 'allocation/committed', state, movedCount: 0, duplicate: true });
    expect(next).toBe(state);
  });
});

describe('workspace/syncExternal reducer', () => {
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

  it('adopts external state and merges unknown audit entries without duplication', () => {
    const local = createSeedWorkspace();
    const externalState = {
      ...createSeedWorkspace(),
      issues: local.issues.map((issue) =>
        issue.id === 'issue-entry-copy' ? { ...issue, owner: 'Rina Solberg', version: 1 } : issue),
      assignmentLog: [externalAudit],
    };
    const adopted = { ...externalState, assignmentLog: [externalAudit] };
    const synced = workspaceReducer(local, { type: 'workspace/syncExternal', state: adopted, audit: [externalAudit] });
    expect(synced.issues.find((issue) => issue.id === 'issue-entry-copy')!.owner).toBe('Rina Solberg');
    expect(synced.assignmentLog).toHaveLength(1);
    const resynced = workspaceReducer(synced, { type: 'workspace/syncExternal', state: adopted, audit: [externalAudit] });
    expect(resynced.assignmentLog).toHaveLength(1);
  });

  it('preserves the complete audit trail without truncating it', () => {
    const state = createSeedWorkspace();
    const many: AssignmentAuditEntry[] = Array.from({ length: 75 }, (_, index) => ({
      ...externalAudit,
      id: `audit-issue-entry-copy-old-${index}`,
      planId: `plan-old-${index}`,
      timestamp: `2026-09-01T00:${String(index).padStart(2, '0')}:00.000Z`,
    }));
    const local: WorkspaceState = { ...state, assignmentLog: many };
    const externalState: WorkspaceState = {
      ...state,
      assignmentLog: [...many, externalAudit],
    };
    const adopted = { ...externalState, assignmentLog: [...many, externalAudit] };
    const synced = workspaceReducer(local, { type: 'workspace/syncExternal', state: adopted, audit: [...many, externalAudit] });
    expect(synced.assignmentLog).toHaveLength(76);
  });
});
