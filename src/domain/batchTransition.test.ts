import { describe, expect, it } from 'vitest';
import {
  BATCH_REGISTRY_LIMIT,
  countBatchResults,
  mergeBatchReports,
  planIssueBatchTransition,
  recordBatchReport,
} from './batchTransition';
import type { BatchTransitionIntent, IssueStatus, ReviewIssue, WorkspaceState } from './models';
import { createSeedWorkspace } from '../state/seed';

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

function intent(issueId: string, target: IssueStatus, baseRevision = 1): BatchTransitionIntent {
  return { issueId, target, baseRevision };
}

describe('planIssueBatchTransition', () => {
  it('applies an all-valid batch with uniform timestamps and audit data', () => {
    const state = makeState(
      makeIssue('a', 'open'),
      makeIssue('b', 'in-progress'),
      makeIssue('c', 'resolved'),
    );
    const plan = planIssueBatchTransition(state, [
      intent('a', 'in-progress'),
      intent('b', 'resolved'),
      intent('c', 'in-progress'),
    ], { batchId: 'batch-1', at: AT });

    expect(plan.report.counts).toEqual({ applied: 3, skipped: 0, conflict: 0, invalid: 0 });
    expect(plan.updates).toHaveLength(3);

    const [started, resolved, reopened] = plan.updates;
    // Necessary timestamps and audit data are updated uniformly.
    expect(started.status).toBe('in-progress');
    expect(started.updatedAt).toBe(AT.toISOString());
    expect(started.revision).toBe(2);
    expect(started.lastBatchId).toBe('batch-1');
    expect(resolved.resolvedAt).toBe(AT.toISOString());
    // Reopening clears the resolution marker.
    expect(reopened.resolvedAt).toBeUndefined();
    // Results are explainable and keep intent order.
    expect(plan.report.results.map((result) => [result.issueId, result.outcome])).toEqual([
      ['a', 'applied'],
      ['b', 'applied'],
      ['c', 'applied'],
    ]);
    expect(plan.report.at).toBe(AT.toISOString());
  });

  it('returns per-item explainable results for a mixed batch', () => {
    const state = makeState(
      makeIssue('ok', 'open'),
      makeIssue('same', 'in-progress'),
      makeIssue('illegal', 'open'),
    );
    const plan = planIssueBatchTransition(state, [
      intent('ok', 'in-progress'),
      intent('same', 'in-progress'),
      intent('illegal', 'resolved'),
      intent('missing', 'in-progress'),
    ], { batchId: 'batch-2', at: AT });

    expect(plan.report.counts).toEqual({ applied: 1, skipped: 1, conflict: 0, invalid: 2 });
    expect(plan.updates.map((issue) => issue.id)).toEqual(['ok']);

    const [applied, skipped, illegal, missing] = plan.report.results;
    expect(applied).toMatchObject({ outcome: 'applied', from: 'open', to: 'in-progress', revision: 2 });
    expect(skipped).toMatchObject({ outcome: 'skipped', reason: 'already-in-target', status: 'in-progress' });
    expect(illegal).toMatchObject({ outcome: 'invalid', reason: 'illegal-transition', from: 'open', to: 'resolved' });
    expect(missing).toMatchObject({ outcome: 'invalid', reason: 'not-found' });
  });

  it('flags records changed by another operation as conflicts and holds them back', () => {
    const state = makeState(makeIssue('hot', 'open', 3));
    const plan = planIssueBatchTransition(state, [intent('hot', 'in-progress', 1)], { batchId: 'batch-3', at: AT });

    expect(plan.updates).toHaveLength(0);
    expect(plan.report.results[0]).toEqual({
      issueId: 'hot',
      outcome: 'conflict',
      reason: 'externally-modified',
      expectedRevision: 1,
      currentRevision: 3,
      currentStatus: 'open',
    });
    // The original record is untouched.
    expect(state.issues[0].status).toBe('open');
    expect(state.issues[0].revision).toBe(3);
  });

  it('retries a conflicted record once it is rebased onto the current revision', () => {
    const state = makeState(makeIssue('hot', 'open', 3));
    const retry = planIssueBatchTransition(state, [intent('hot', 'in-progress', 3)], { batchId: 'batch-4', at: AT });
    expect(retry.report.counts.applied).toBe(1);
    expect(retry.updates[0]).toMatchObject({ id: 'hot', status: 'in-progress', revision: 4, lastBatchId: 'batch-4' });
  });

  it('treats already-applied items as idempotent skips when a batch is retried', () => {
    const state = makeState(makeIssue('a', 'open'), makeIssue('b', 'open'));
    const first = planIssueBatchTransition(state, [intent('a', 'in-progress'), intent('b', 'in-progress')], { batchId: 'batch-5', at: AT });
    // Simulate the first attempt committing, then the same intents being retried
    // against the new state: nothing is written a second time.
    const afterFirst = makeState(...first.updates);
    const second = planIssueBatchTransition(afterFirst, [intent('a', 'in-progress'), intent('b', 'in-progress')], { batchId: 'batch-5-retry', at: new Date('2026-09-12T11:00:00.000Z') });

    expect(second.report.counts).toEqual({ applied: 0, skipped: 2, conflict: 0, invalid: 0 });
    expect(second.updates).toHaveLength(0);
    // Skipped records keep their original timestamps (no write churn).
    expect(afterFirst.issues[0].updatedAt).toBe(AT.toISOString());
  });

  it('rejects duplicate intents for the same record inside one batch', () => {
    const state = makeState(makeIssue('a', 'open'));
    const plan = planIssueBatchTransition(state, [intent('a', 'in-progress'), intent('a', 'in-progress')], { batchId: 'batch-6', at: AT });
    expect(plan.report.counts).toEqual({ applied: 1, skipped: 0, conflict: 0, invalid: 1 });
    expect(plan.report.results[1]).toMatchObject({ outcome: 'invalid', reason: 'duplicate-in-batch' });
  });

  it('is a pure dry-run: planning never mutates the workspace (cancel leaves no trace)', () => {
    const state = makeState(makeIssue('a', 'open'), makeIssue('b', 'in-progress'));
    const snapshot = structuredClone(state);
    planIssueBatchTransition(state, [intent('a', 'in-progress'), intent('b', 'resolved')], { batchId: 'batch-7', at: AT });
    expect(state).toEqual(snapshot);
  });
});

describe('batch report registry', () => {
  it('records reports idempotently and bounds the registry size', () => {
    const state = makeState(makeIssue('a', 'open'));
    const plan = planIssueBatchTransition(state, [intent('a', 'in-progress')], { batchId: 'batch-8', at: AT });

    let registry = recordBatchReport(undefined, plan.report);
    registry = recordBatchReport(registry, plan.report);
    expect(Object.keys(registry)).toEqual(['batch-8']);

    let filled = registry;
    for (let index = 0; index < BATCH_REGISTRY_LIMIT + 10; index += 1) {
      filled = recordBatchReport(filled, { ...plan.report, batchId: `batch-extra-${index}`, at: new Date(AT.getTime() + index + 1).toISOString() });
    }
    expect(Object.keys(filled)).toHaveLength(BATCH_REGISTRY_LIMIT);
    expect(filled['batch-8']).toBeUndefined();
  });
});

describe('mergeBatchReports', () => {
  it('folds a retry report into a single triaged result', () => {
    const state = makeState(makeIssue('a', 'open'), makeIssue('b', 'open', 2));
    const first = planIssueBatchTransition(state, [intent('a', 'in-progress'), intent('b', 'in-progress', 1)], { batchId: 'batch-9', at: AT }).report;
    expect(first.counts).toEqual({ applied: 1, skipped: 0, conflict: 1, invalid: 0 });

    const retry = planIssueBatchTransition(state, [intent('b', 'in-progress', 2)], { batchId: 'batch-10', at: AT }).report;
    const merged = mergeBatchReports(first, retry);

    expect(merged.batchId).toBe('batch-10');
    expect(merged.counts).toEqual({ applied: 2, skipped: 0, conflict: 0, invalid: 0 });
    expect(merged.results.map((result) => result.issueId)).toEqual(['a', 'b']);
    expect(countBatchResults(merged.results)).toEqual(merged.counts);
  });
});
