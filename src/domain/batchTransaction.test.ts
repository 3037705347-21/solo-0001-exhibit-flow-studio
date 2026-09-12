import { describe, expect, it } from 'vitest';
import { createSeedWorkspace } from '../state/seed';
import {
  BATCH_FIELDS,
  commitBatchTransaction,
  EMPTY_BATCH_AUDIT,
  planBatchTransaction,
  validatePatchShape,
  type BatchAuditState,
  type BatchTransaction,
} from './batchTransaction';
import type { WorkspaceState } from './models';

function baseState(): WorkspaceState {
  return createSeedWorkspace();
}

function planFor(state: WorkspaceState, ids: string[], patch: BatchTransaction['items'][number]['patch']) {
  const selections = ids.map((artifactId) => {
    const artifact = state.artifacts.find((candidate) => candidate.id === artifactId)!;
    return { artifactId, baseRevision: artifact.updatedAt, patch };
  });
  return planBatchTransaction({ id: 'batch-test-1', artifacts: state.artifacts, selections });
}

function touchArtifact(state: WorkspaceState, artifactId: string): WorkspaceState {
  return {
    ...state,
    artifacts: state.artifacts.map((artifact) => artifact.id === artifactId
      ? { ...artifact, dwellMinutes: artifact.dwellMinutes === 4 ? 5 : artifact.dwellMinutes + 1, updatedAt: '2026-09-10T00:00:00.000Z' }
      : artifact),
  };
}

describe('batch transaction planning', () => {
  it('plans a safe transaction with a per-field diff against the reviewed revision', () => {
    const state = baseState();
    const { transaction, items } = planFor(state, ['artifact-lantern', 'artifact-radio'], { sensitivity: 'fragile' });
    expect(items).toHaveLength(0);
    expect(transaction).not.toBeNull();
    expect(transaction!.items).toHaveLength(2);
    expect(transaction!.items[0].changes).toEqual([{ field: 'sensitivity', from: 'standard', to: 'fragile' }]);
  });

  it('reports stale and missing records at preparation time instead of planning them', () => {
    const state = baseState();
    const lantern = state.artifacts.find((a) => a.id === 'artifact-lantern')!;
    const radio = state.artifacts.find((a) => a.id === 'artifact-radio')!;
    const liveArtifacts = touchArtifact(state, 'artifact-lantern').artifacts
      .filter((a) => a.id !== 'artifact-radio');
    const result = planBatchTransaction({
      id: 'batch-plan-conflicts',
      artifacts: liveArtifacts,
      selections: [
        { artifactId: lantern.id, baseRevision: lantern.updatedAt, patch: { sensitivity: 'fragile' } },
        { artifactId: radio.id, baseRevision: radio.updatedAt, patch: { sensitivity: 'fragile' } },
      ],
    });
    expect(result.transaction).toBeNull();
    expect(result.items.map((i) => i.status).sort()).toEqual(['missing', 'stale']);
  });

  it('rejects illegal fields even when they appear in a single item patch', () => {
    const errors = validatePatchShape({ id: 'artifact-x', title: 'hacked', unknownField: 1, dwellMinutes: 40 });
    const fields = errors.map((e) => e.field);
    expect(fields).toContain('id');
    expect(fields).toContain('title');
    expect(fields).toContain('unknownField');
    expect(errors.some((e) => e.field === 'dwellMinutes')).toBe(true);
    expect(validatePatchShape({ sensitivity: 'not-a-value' })).toHaveLength(1);
    expect(validatePatchShape({ isKeyObject: true })).toEqual([]);
  });

  it('flags illegal values such as out-of-range dwell time at the patch boundary', () => {
    const errors = validatePatchShape({ dwellMinutes: 99 });
    expect(errors[0].field).toBe('dwellMinutes');
    expect(BATCH_FIELDS).toContain('dwellMinutes');
  });
});

describe('batch transaction commit', () => {
  it('applies every change atomically with one shared updatedAt and an audit record', () => {
    const state = baseState();
    const { transaction } = planFor(state, ['artifact-lantern', 'artifact-radio'], { sensitivity: 'fragile' });
    const now = new Date('2026-09-12T10:00:00.000Z');
    const outcome = commitBatchTransaction({ state, audit: EMPTY_BATCH_AUDIT, transaction: transaction!, now });
    expect(outcome.status).toBe('committed');
    if (outcome.status !== 'committed') throw new Error('expected commit');
    const stamps = outcome.state.artifacts
      .filter((a) => ['artifact-lantern', 'artifact-radio'].includes(a.id))
      .map((a) => a.updatedAt);
    expect(stamps).toEqual(['2026-09-12T10:00:00.000Z', '2026-09-12T10:00:00.000Z']);
    expect(outcome.state.artifacts.find((a) => a.id === 'artifact-lantern')!.sensitivity).toBe('fragile');
    // Placements remain linked to the same artifact ids.
    const arrival = outcome.state.zones.find((z) => z.id === 'zone-arrival')!;
    expect(arrival.artifactIds).toContain('artifact-lantern');
    // Findings stay linked to the edited artifact.
    expect(outcome.state.issues.some((i) => i.artifactId === 'artifact-tape')).toBe(true);
    expect(outcome.transaction.artifactIds).toEqual(['artifact-lantern', 'artifact-radio']);
    expect(outcome.transaction.appliedRevision).toBe('2026-09-12T10:00:00.000Z');
  });

  it('leaves no half-applied update when one record changed after review (version conflict)', () => {
    const state = baseState();
    const { transaction } = planFor(state, ['artifact-lantern', 'artifact-radio'], { sensitivity: 'fragile' });
    const changedState = touchArtifact(state, 'artifact-lantern');
    const outcome = commitBatchTransaction({ state: changedState, audit: EMPTY_BATCH_AUDIT, transaction: transaction! });
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') throw new Error('expected rejection');
    const statuses = Object.fromEntries(outcome.items.map((i) => [i.artifactId, i.status]));
    expect(statuses['artifact-lantern']).toBe('stale');
    expect(statuses['artifact-radio']).toBe('safe');
    // Atomicity: the safe item must not have been applied.
    expect(changedState.artifacts.find((a) => a.id === 'artifact-radio')!.sensitivity).toBe('standard');
    expect(changedState.artifacts.find((a) => a.id === 'artifact-lantern')!.updatedAt).toBe('2026-09-10T00:00:00.000Z');
  });

  it('marks a stale-but-compatible record separately so the UI can explain it', () => {
    const state = baseState();
    const { transaction } = planFor(state, ['artifact-lantern'], { sensitivity: 'fragile' });
    // External edit arrives at the same end value the patch requests.
    const concurrently: WorkspaceState = {
      ...state,
      artifacts: state.artifacts.map((a) => a.id === 'artifact-lantern'
        ? { ...a, sensitivity: 'fragile', updatedAt: '2026-09-10T00:00:00.000Z' }
        : a),
    };
    const outcome = commitBatchTransaction({ state: concurrently, audit: EMPTY_BATCH_AUDIT, transaction: transaction! });
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') throw new Error('expected rejection');
    expect(outcome.items[0].status).toBe('stale');
    expect(outcome.items[0].conflictsWithPatch).toBe(false);
  });

  it('rejects the entire batch when a record no longer exists', () => {
    const state = baseState();
    const { transaction } = planFor(state, ['artifact-lantern', 'artifact-radio'], { narrativeRole: 'reflection' });
    const removedState: WorkspaceState = {
      ...state,
      artifacts: state.artifacts.filter((a) => a.id !== 'artifact-radio'),
    };
    const outcome = commitBatchTransaction({ state: removedState, audit: EMPTY_BATCH_AUDIT, transaction: transaction! });
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') throw new Error('expected rejection');
    expect(outcome.items.find((i) => i.artifactId === 'artifact-radio')!.status).toBe('missing');
    expect(removedState.artifacts.find((a) => a.id === 'artifact-lantern')!.narrativeRole).toBe('threshold');
  });

  it('rejects when a record becomes invalid at submit time (whole batch, no partial writes)', () => {
    const state = baseState();
    const lantern = state.artifacts.find((a) => a.id === 'artifact-lantern')!;
    // Hand-build a transaction that requests an out-of-range dwell. The commit
    // engine must re-validate against the live record, not trust the plan.
    const transaction: BatchTransaction = {
      id: 'batch-invalid-live',
      createdAt: '2026-09-12T09:00:00.000Z',
      items: [{
        artifactId: lantern.id,
        baseRevision: lantern.updatedAt,
        patch: { dwellMinutes: 99 },
        changes: [{ field: 'dwellMinutes', from: lantern.dwellMinutes, to: 99 }],
      }],
    };
    const outcome = commitBatchTransaction({ state, audit: EMPTY_BATCH_AUDIT, transaction });
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') throw new Error('expected rejection');
    expect(outcome.items[0].status).toBe('invalid');
    expect(outcome.items[0].errors.some((e) => e.field === 'dwellMinutes')).toBe(true);
    expect(state.artifacts.find((a) => a.id === 'artifact-lantern')!.dwellMinutes).toBe(4);
  });

  it('does not record or apply a retried transaction twice (idempotency)', () => {
    const state = baseState();
    const { transaction } = planFor(state, ['artifact-lantern'], { sensitivity: 'fragile' });
    const audit: BatchAuditState = { transactions: EMPTY_BATCH_AUDIT.transactions };
    const first = commitBatchTransaction({ state, audit, transaction: transaction!, now: new Date('2026-09-12T10:00:00.000Z') });
    expect(first.status).toBe('committed');
    if (first.status !== 'committed') throw new Error('expected commit');
    const afterAudit: BatchAuditState = { transactions: [first.transaction] };
    // Retry against the *new* state: must return the stored record, not re-apply.
    const retry = commitBatchTransaction({ state: first.state, audit: afterAudit, transaction: transaction! });
    expect(retry.status).toBe('duplicate');
    if (retry.status !== 'duplicate') throw new Error('expected duplicate');
    expect(retry.transaction.committedAt).toBe('2026-09-12T10:00:00.000Z');
    expect(first.state.artifacts.filter((a) => a.updatedAt === '2026-09-12T10:00:00.000Z')).toHaveLength(1);
    // Retry against the *original* stale state also never writes.
    const retryAgainstOld = commitBatchTransaction({ state, audit: afterAudit, transaction: transaction! });
    expect(retryAgainstOld.status).toBe('duplicate');
    expect(state.artifacts.find((a) => a.id === 'artifact-lantern')!.sensitivity).toBe('standard');
  });

  it('a cancelled (never committed) transaction leaves state and audit untouched', () => {
    const state = baseState();
    const { transaction } = planFor(state, ['artifact-lantern'], { sensitivity: 'fragile' });
    // Cancellation is simply not calling commit: the same plan can later be
    // committed under a fresh review without any duplicate-record risk.
    expect(EMPTY_BATCH_AUDIT.transactions).toHaveLength(0);
    expect(state.artifacts.find((a) => a.id === 'artifact-lantern')!.sensitivity).toBe('standard');
    const later = commitBatchTransaction({
      state,
      audit: EMPTY_BATCH_AUDIT,
      transaction: { ...transaction!, id: 'batch-after-cancel' },
      now: new Date('2026-09-12T11:00:00.000Z'),
    });
    expect(later.status).toBe('committed');
  });

  it('keeps an object that already has the requested values as a safe no-op member', () => {
    const stateReady: WorkspaceState = {
      ...baseState(),
      project: { ...baseState().project, stage: 'ready' },
    };
    // Lantern is already standard sensitivity, radio is not.
    const result = planFor(stateReady, ['artifact-lantern', 'artifact-radio'], { sensitivity: 'standard' });
    expect(result.items).toHaveLength(0);
    expect(result.transaction!.items.map((i) => i.changes.length)).toEqual([0, 0]);
    // Radio also starts as 'standard' in the seed, so pick a genuinely
    // changing value instead for the commit assertion.
    const changing = planFor(stateReady, ['artifact-lantern', 'artifact-radio'], { sensitivity: 'low-light' });
    const outcome = commitBatchTransaction({ state: stateReady, audit: EMPTY_BATCH_AUDIT, transaction: changing.transaction! });
    expect(outcome.status).toBe('committed');
    if (outcome.status !== 'committed') throw new Error('expected commit');
    expect(outcome.transaction.itemCount).toBe(2);
    expect(outcome.transaction.fields).toEqual(['sensitivity']);
  });


});
