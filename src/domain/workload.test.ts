import { describe, expect, it } from 'vitest';
import type { ReviewIssue, WorkspaceState } from './models';
import { createSeedWorkspace } from '../state/seed';
import {
  commitAllocation,
  createAllocationDraft,
  detectConflicts,
  ownerOptions,
  previewWorkload,
  rebalanceDraft,
  refreshAllocationDraft,
  setDraftTarget,
} from './workload';

function makeIssue(overrides: Partial<ReviewIssue> & Pick<ReviewIssue, 'id' | 'owner' | 'severity' | 'status'>): ReviewIssue {
  return {
    title: `Finding ${overrides.id}`,
    description: 'Enough context for a review finding used in workload tests.',
    zoneId: 'zone-arrival',
    version: 0,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

function stateWith(issues: ReviewIssue[]): WorkspaceState {
  const seed = createSeedWorkspace();
  return { ...seed, zones: seed.zones, issues, assignmentLog: [] };
}

describe('workload allocation draft', () => {
  it('pins each selected finding to its owner and version when the batch opens', () => {
    const state = stateWith([
      makeIssue({ id: 'a', owner: 'Mara', severity: 'critical', status: 'open' }),
      makeIssue({ id: 'b', owner: 'Theo', severity: 'note', status: 'in-progress', version: 4 }),
    ]);
    const draft = createAllocationDraft(state.issues, ['a', 'b'], new Date('2026-09-10T09:00:00Z'));
    expect(draft.items).toHaveLength(2);
    expect(draft.items[0]).toMatchObject({ issueId: 'a', fromOwner: 'Mara', ackOwner: 'Mara', baseVersion: 0, ackVersion: 0, targetOwner: 'Mara' });
    expect(draft.items[1]).toMatchObject({ issueId: 'b', baseVersion: 4, ackVersion: 4 });
    expect(draft.planId).toMatch(/^plan-/);
  });

  it('only includes selected findings', () => {
    const state = stateWith([
      makeIssue({ id: 'a', owner: 'Mara', severity: 'note', status: 'open' }),
      makeIssue({ id: 'b', owner: 'Theo', severity: 'note', status: 'open' }),
    ]);
    const draft = createAllocationDraft(state.issues, ['a']);
    expect(draft.items.map((item) => item.issueId)).toEqual(['a']);
  });
});

describe('previewWorkload', () => {
  it('shows counts, severity weights and affected zones before and after the batch', () => {
    const state = stateWith([
      makeIssue({ id: 'a', owner: 'Mara', severity: 'critical', status: 'open', zoneId: 'zone-arrival' }),
      makeIssue({ id: 'b', owner: 'Mara', severity: 'note', status: 'in-progress', zoneId: 'zone-after' }),
      makeIssue({ id: 'c', owner: 'Theo', severity: 'warning', status: 'open', zoneId: 'zone-patterns' }),
      makeIssue({ id: 'd', owner: 'Rina', severity: 'note', status: 'resolved', zoneId: 'zone-common' }),
    ]);
    let draft = createAllocationDraft(state.issues, ['a']);
    draft = setDraftTarget(draft, 'a', 'Theo');
    const preview = previewWorkload(state, draft);

    const mara = preview.rows.find((row) => row.owner === 'Mara')!;
    const theo = preview.rows.find((row) => row.owner === 'Theo')!;
    // Mara: critical (3) + note (1) → 4 weight, 2 findings. After losing critical: 1 / 1.
    expect(mara.beforeCount).toBe(2);
    expect(mara.afterCount).toBe(1);
    expect(mara.beforeWeight).toBe(4);
    expect(mara.afterWeight).toBe(1);
    expect(mara.loses).toHaveLength(1);
    // Theo gains the critical but keeps the resolved finding out of the load math.
    expect(theo.beforeWeight).toBe(2);
    expect(theo.afterWeight).toBe(5);
    expect(theo.receives.map((item) => item.issueId)).toEqual(['a']);
    expect(theo.afterZoneIds).toEqual(expect.arrayContaining(['zone-arrival', 'zone-patterns']));
    // Resolved findings never create a load row for their owner on their own.
    expect(preview.rows.some((row) => row.owner === 'Rina')).toBe(false);
  });

  it('reports the batch as unbalanced when severity weight spread stays above one', () => {
    const state = stateWith([
      makeIssue({ id: 'a', owner: 'Mara', severity: 'critical', status: 'open' }),
      makeIssue({ id: 'b', owner: 'Mara', severity: 'warning', status: 'open' }),
      makeIssue({ id: 'c', owner: 'Theo', severity: 'note', status: 'open' }),
    ]);
    const draft = createAllocationDraft(state.issues, []);
    const preview = previewWorkload(state, draft);
    expect(preview.balanced).toBe(false);
    expect(preview.weightSpread).toBe(4);
  });
});

describe('rebalanceDraft', () => {
  it('moves heavy findings to the lightest owner until weight spread is at most one', () => {
    const state = stateWith([
      makeIssue({ id: 'a', owner: 'Mara', severity: 'critical', status: 'open' }),
      makeIssue({ id: 'b', owner: 'Mara', severity: 'warning', status: 'open' }),
      makeIssue({ id: 'c', owner: 'Theo', severity: 'note', status: 'open' }),
    ]);
    const draft = createAllocationDraft(state.issues, ['a', 'b', 'c']);
    const balanced = rebalanceDraft(state, draft);
    const preview = previewWorkload(state, balanced);
    // Total weight 6 across two owners: 3/3.
    expect(preview.balanced).toBe(true);
    const targets = Object.fromEntries(balanced.items.map((item) => [item.issueId, item.targetOwner]));
    expect(new Set(Object.values(targets)).size).toBe(2);
  });

  it('never moves resolved findings', () => {
    const state = stateWith([
      makeIssue({ id: 'a', owner: 'Mara', severity: 'note', status: 'resolved' }),
      makeIssue({ id: 'b', owner: 'Theo', severity: 'critical', status: 'open' }),
    ]);
    const draft = createAllocationDraft(state.issues, ['a', 'b']);
    const balanced = rebalanceDraft(state, draft);
    const resolved = balanced.items.find((item) => item.issueId === 'a')!;
    expect(resolved.targetOwner).toBe('Mara');
  });

  it('does nothing when only one owner exists', () => {
    const state = stateWith([
      makeIssue({ id: 'a', owner: 'Solo', severity: 'critical', status: 'open' }),
    ]);
    const draft = createAllocationDraft(state.issues, ['a']);
    expect(rebalanceDraft(state, draft)).toEqual(draft);
  });
});

describe('detectConflicts', () => {
  const baseState = () => stateWith([
    makeIssue({ id: 'a', owner: 'Mara', severity: 'warning', status: 'open', version: 1 }),
  ]);

  it('flags a finding whose status changed externally', () => {
    const state = baseState();
    const draft = createAllocationDraft(state.issues, ['a']);
    const drifted: WorkspaceState = {
      ...state,
      issues: [makeIssue({ id: 'a', owner: 'Mara', severity: 'warning', status: 'in-progress', version: 2 })],
    };
    const conflicts = detectConflicts(draft.items, drifted.issues);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].type).toBe('status-changed');
  });

  it('flags a finding reassigned by someone else', () => {
    const state = baseState();
    const draft = createAllocationDraft(state.issues, ['a']);
    const drifted: WorkspaceState = {
      ...state,
      issues: [makeIssue({ id: 'a', owner: 'Theo', severity: 'warning', status: 'open', version: 2 })],
    };
    expect(detectConflicts(draft.items, drifted.issues)[0].type).toBe('owner-changed');
  });

  it('flags a version bump even when owner and status look unchanged', () => {
    const state = baseState();
    const draft = createAllocationDraft(state.issues, ['a']);
    const drifted: WorkspaceState = {
      ...state,
      issues: [makeIssue({ id: 'a', owner: 'Mara', severity: 'warning', status: 'open', version: 5 })],
    };
    expect(detectConflicts(draft.items, drifted.issues)[0].type).toBe('version-stale');
  });

  it('flags a missing finding', () => {
    const state = baseState();
    const draft = createAllocationDraft(state.issues, ['a']);
    expect(detectConflicts(draft.items, [])[0].type).toBe('missing');
  });

  it('clears conflicts after the draft is refreshed over the newer state', () => {
    const state = baseState();
    const draft = createAllocationDraft(state.issues, ['a']);
    const drifted: WorkspaceState = {
      ...state,
      issues: [makeIssue({ id: 'a', owner: 'Theo', severity: 'warning', status: 'open', version: 2 })],
    };
    expect(detectConflicts(draft.items, drifted.issues)).toHaveLength(1);
    const rebased = refreshAllocationDraft(draft, drifted);
    expect(detectConflicts(rebased.items, drifted.issues)).toHaveLength(0);
    // Targets and the original snapshot survive the refresh.
    expect(rebased.items[0].fromOwner).toBe('Mara');
    expect(rebased.items[0].ackOwner).toBe('Theo');
  });
});

describe('commitAllocation', () => {
  it('applies every move atomically, bumps versions, updates timestamps and appends audit entries', () => {
    const state = stateWith([
      makeIssue({ id: 'a', owner: 'Mara', severity: 'critical', status: 'open', version: 2 }),
      makeIssue({ id: 'b', owner: 'Mara', severity: 'note', status: 'in-progress', version: 0 }),
      makeIssue({ id: 'c', owner: 'Theo', severity: 'warning', status: 'open', version: 1 }),
    ]);
    let draft = createAllocationDraft(state.issues, ['a', 'b'], new Date('2026-09-10T11:00:00Z'));
    draft = setDraftTarget(draft, 'a', 'Theo');
    draft = setDraftTarget(draft, 'b', 'Rina');
    const result = commitAllocation(state, draft, new Date('2026-09-10T12:00:00Z'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const after = result.state.issues;
    const a = after.find((issue) => issue.id === 'a')!;
    const b = after.find((issue) => issue.id === 'b')!;
    const c = after.find((issue) => issue.id === 'c')!;
    expect(a.owner).toBe('Theo');
    expect(a.version).toBe(3);
    expect(a.status).toBe('open');
    expect(a.zoneId).toBe('zone-arrival');
    expect(a.title).toBe('Finding a');
    expect(a.updatedAt).toBe('2026-09-10T12:00:00.000Z');
    expect(b.owner).toBe('Rina');
    expect(b.version).toBe(1);
    expect(c).toMatchObject({ owner: 'Theo', version: 1 });
    expect(result.audit).toHaveLength(2);
    expect(result.state.assignmentLog).toHaveLength(2);
    expect(result.state.assignmentLog[0]).toMatchObject({
      planId: draft.planId,
      issueId: 'a',
      fromOwner: 'Mara',
      toOwner: 'Theo',
      fromStatus: 'open',
      toStatus: 'open',
    });
  });

  it('writes nothing when any finding drifted since the acknowledged baseline', () => {
    const state = stateWith([
      makeIssue({ id: 'a', owner: 'Mara', severity: 'warning', status: 'open', version: 1 }),
      makeIssue({ id: 'b', owner: 'Mara', severity: 'note', status: 'open', version: 0 }),
    ]);
    let draft = createAllocationDraft(state.issues, ['a', 'b']);
    draft = setDraftTarget(draft, 'a', 'Theo');
    draft = setDraftTarget(draft, 'b', 'Theo');
    const drifted: WorkspaceState = {
      ...state,
      issues: [
        makeIssue({ id: 'a', owner: 'Mara', severity: 'warning', status: 'open', version: 1 }),
        makeIssue({ id: 'b', owner: 'Rina', severity: 'note', status: 'open', version: 2 }),
      ],
    };
    const result = commitAllocation(drifted, draft);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflicts[0].issueId).toBe('b');
    // No partial application: 'a' must stay with Mara even though its own check passed.
    expect(drifted.issues[0].owner).toBe('Mara');
  });

  it('treats a repeated commit of the same plan as a duplicate confirmation', () => {
    const state = stateWith([
      makeIssue({ id: 'a', owner: 'Mara', severity: 'note', status: 'open' }),
    ]);
    let draft = createAllocationDraft(state.issues, ['a']);
    draft = setDraftTarget(draft, 'a', 'Theo');
    const first = commitAllocation(state, draft);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = commitAllocation(first.state, draft);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.duplicate).toBe(true);
    expect(second.state).toBe(first.state);
    expect(second.audit).toEqual([]);
    expect(first.state.assignmentLog).toHaveLength(1);
  });

  it('rejects blank target owners without writing', () => {
    const state = stateWith([
      makeIssue({ id: 'a', owner: 'Mara', severity: 'note', status: 'open' }),
    ]);
    const draft = setDraftTarget(createAllocationDraft(state.issues, ['a']), 'a', '   ');
    const result = commitAllocation(state, draft);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflicts[0].type).toBe('invalid-target');
  });

  it('is a no-op success when nothing actually moves', () => {
    const state = stateWith([
      makeIssue({ id: 'a', owner: 'Mara', severity: 'note', status: 'open' }),
    ]);
    const draft = createAllocationDraft(state.issues, ['a']);
    const result = commitAllocation(state, draft);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.audit).toEqual([]);
  });
});

describe('ownerOptions', () => {
  it('merges workspace owners with draft targets so new owners stay selectable', () => {
    const state = stateWith([
      makeIssue({ id: 'a', owner: 'Mara', severity: 'note', status: 'open' }),
    ]);
    let draft = createAllocationDraft(state.issues, ['a']);
    draft = setDraftTarget(draft, 'a', 'Zoe');
    expect(ownerOptions(state, draft)).toEqual(['Mara', 'Zoe']);
  });
});
