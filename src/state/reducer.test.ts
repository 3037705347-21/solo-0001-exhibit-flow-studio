import { describe, expect, it } from 'vitest';
import type { IssueStatus, ReviewIssue, WorkspaceState } from '../domain/models';
import type { WorkspaceAction } from './actions';
import { workspaceReducer } from './reducer';
import { createSeedWorkspace } from './seed';

const AT = new Date('2026-09-12T10:00:00.000Z');

function makeIssue(id: string, status: IssueStatus, revision = 1): ReviewIssue {
  return {
    id,
    title: `Finding ${id}`,
    description: `Context for ${id}`,
    severity: 'warning',
    status,
    owner: 'Reviewer',
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    resolvedAt: status === 'resolved' ? '2026-09-01T09:00:00.000Z' : undefined,
    revision,
  };
}

function makeState(...issues: ReviewIssue[]): WorkspaceState {
  return { ...createSeedWorkspace(), issues };
}

describe('issue/batch-transition', () => {
  it('commits every valid record in a single atomic state transition', () => {
    const state = makeState(makeIssue('a', 'open'), makeIssue('b', 'in-progress'), makeIssue('c', 'resolved'));
    const next = workspaceReducer(state, {
      type: 'issue/batch-transition',
      batchId: 'batch-1',
      intents: [
        { issueId: 'a', target: 'in-progress', baseRevision: 1 },
        { issueId: 'b', target: 'resolved', baseRevision: 1 },
        { issueId: 'c', target: 'in-progress', baseRevision: 1 },
      ],
      at: AT,
    });

    expect(next.issues.map((issue) => issue.status)).toEqual(['in-progress', 'resolved', 'in-progress']);
    expect(next.issues.every((issue) => issue.revision === 2 && issue.lastBatchId === 'batch-1')).toBe(true);
    expect(next.processedBatches?.['batch-1'].counts).toEqual({ applied: 3, skipped: 0, conflict: 0, invalid: 0 });
  });

  it('applies valid items and leaves invalid or unchanged records exactly as they were', () => {
    const state = makeState(makeIssue('ok', 'open'), makeIssue('same', 'in-progress'), makeIssue('illegal', 'open'));
    const next = workspaceReducer(state, {
      type: 'issue/batch-transition',
      batchId: 'batch-2',
      intents: [
        { issueId: 'ok', target: 'in-progress', baseRevision: 1 },
        { issueId: 'same', target: 'in-progress', baseRevision: 1 },
        { issueId: 'illegal', target: 'resolved', baseRevision: 1 },
        { issueId: 'missing', target: 'open', baseRevision: 1 },
      ],
      at: AT,
    });

    const [ok, same, illegal] = next.issues;
    expect(ok.status).toBe('in-progress');
    // Skipped and invalid records are not rewritten — no half-applied state.
    expect(same).toBe(state.issues[1]);
    expect(illegal).toBe(state.issues[2]);
    expect(next.processedBatches?.['batch-2'].counts).toEqual({ applied: 1, skipped: 1, conflict: 0, invalid: 2 });
  });

  it('re-checks records at commit time when another operation changed them first', () => {
    const state = makeState(makeIssue('a', 'open'), makeIssue('b', 'open'));
    // An external operation moves finding b before the batch commits.
    const externallyChanged = workspaceReducer(state, { type: 'issue/transition', issueId: 'b', status: 'in-progress', at: AT });
    const next = workspaceReducer(externallyChanged, {
      type: 'issue/batch-transition',
      batchId: 'batch-3',
      intents: [
        { issueId: 'a', target: 'in-progress', baseRevision: 1 },
        { issueId: 'b', target: 'resolved', baseRevision: 1 },
      ],
      at: AT,
    });

    const [a, b] = next.issues;
    expect(a.status).toBe('in-progress');
    // b was planned as open -> resolved, but the commit saw in-progress@2 and
    // judged the intent against the current record instead of the stale plan.
    expect(b.status).toBe('in-progress');
    expect(b.revision).toBe(2);
    const results = next.processedBatches?.['batch-3'].results ?? [];
    expect(results[0]).toMatchObject({ issueId: 'a', outcome: 'applied' });
    expect(results[1]).toMatchObject({ issueId: 'b', outcome: 'conflict', reason: 'externally-modified', currentRevision: 2, currentStatus: 'in-progress' });
  });

  it('never writes twice when the same batch is submitted repeatedly', () => {
    const state = makeState(makeIssue('a', 'open'));
    const action: WorkspaceAction = {
      type: 'issue/batch-transition',
      batchId: 'batch-4',
      intents: [{ issueId: 'a', target: 'in-progress', baseRevision: 1 }],
      at: AT,
    };

    const first = workspaceReducer(state, action);
    const second = workspaceReducer(first, action);
    const third = workspaceReducer(second, action);

    expect(first.issues[0]).toMatchObject({ status: 'in-progress', revision: 2, lastBatchId: 'batch-4' });
    // Duplicate submissions are a no-op down to reference identity.
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(Object.keys(first.processedBatches ?? {})).toEqual(['batch-4']);
    expect(first.issues[0].updatedAt).toBe(AT.toISOString());
  });

  it('replays the stored report for a duplicate batch id instead of re-planning', () => {
    const state = makeState(makeIssue('a', 'open'));
    const first = workspaceReducer(state, {
      type: 'issue/batch-transition',
      batchId: 'batch-5',
      intents: [{ issueId: 'a', target: 'in-progress', baseRevision: 1 }],
      at: AT,
    });
    // A later, different state must not change what the committed batch reported.
    const mutated = workspaceReducer(first, { type: 'issue/transition', issueId: 'a', status: 'resolved', at: AT });
    const replayed = workspaceReducer(mutated, {
      type: 'issue/batch-transition',
      batchId: 'batch-5',
      intents: [{ issueId: 'a', target: 'in-progress', baseRevision: 1 }],
      at: AT,
    });
    expect(replayed).toBe(mutated);
    expect(replayed.processedBatches?.['batch-5'].counts).toEqual({ applied: 1, skipped: 0, conflict: 0, invalid: 0 });
  });
});
