import { describe, expect, it } from 'vitest';
import { canPublish, canSignOff, computePlanVersion, evaluateApproval, invalidateApproval } from './approval';
import { createSeedWorkspace } from '../state/seed';
import type { PlanApproval, WorkspaceState } from './models';

function readyWorkspace(): WorkspaceState {
  const seed = createSeedWorkspace();
  return {
    ...seed,
    project: { ...seed.project, stage: 'ready' },
    issues: seed.issues.map((issue) => issue.severity === 'critical' ? { ...issue, status: 'resolved' } : issue),
  };
}

function signOff(state: WorkspaceState, approver = 'Mara Chen'): WorkspaceState {
  const approval: PlanApproval = {
    approver,
    approvedAt: '2026-09-11T09:00:00.000Z',
    planVersion: computePlanVersion(state),
    status: 'active',
  };
  return { ...state, approval };
}

describe('plan version', () => {
  it('stays stable across operations that do not change business content', () => {
    const base = readyWorkspace();
    const version = computePlanVersion(base);
    const rearranged: WorkspaceState = {
      ...base,
      artifacts: [...base.artifacts].reverse(),
      issues: [...base.issues].reverse(),
      preferences: { pace: 'leisurely', accessibilityPriority: 10, groupSize: 2 },
      lastSavedAt: '2030-01-01T00:00:00.000Z',
      project: { ...base.project, stage: 'review', lastReadinessCheck: '2030-01-01T00:00:00.000Z' },
    };
    expect(computePlanVersion(rearranged)).toBe(version);
  });

  it('changes when objects, visit order, or findings change', () => {
    const base = readyWorkspace();
    const version = computePlanVersion(base);
    const editedArtifact: WorkspaceState = {
      ...base,
      artifacts: base.artifacts.map((artifact, index) => index === 0 ? { ...artifact, dwellMinutes: artifact.dwellMinutes + 1 } : artifact),
    };
    const reorderedVisit: WorkspaceState = {
      ...base,
      zones: base.zones.map((zone) => zone.id === 'zone-patterns' ? { ...zone, artifactIds: [...zone.artifactIds].reverse() } : zone),
    };
    const reopenedIssue: WorkspaceState = {
      ...base,
      issues: base.issues.map((issue) => issue.id === 'issue-quilt-light' ? { ...issue, status: 'in-progress' as const } : issue),
    };
    expect(computePlanVersion(editedArtifact)).not.toBe(version);
    expect(computePlanVersion(reorderedVisit)).not.toBe(version);
    expect(computePlanVersion(reopenedIssue)).not.toBe(version);
  });
});

describe('sign-off gate', () => {
  it('refuses sign-off while the plan is not ready', () => {
    const seed = createSeedWorkspace();
    expect(canSignOff(seed).ok).toBe(false);
    const blockedButFlagged: WorkspaceState = { ...seed, project: { ...seed.project, stage: 'ready' } };
    expect(canSignOff(blockedButFlagged).ok).toBe(false);
    expect(canSignOff(readyWorkspace()).ok).toBe(true);
  });

  it('requires an active, current sign-off before publishing', () => {
    const ready = readyWorkspace();
    expect(canPublish(ready).ok).toBe(false);
    const signed = signOff(ready);
    expect(canPublish(signed).ok).toBe(true);
    const regressed: WorkspaceState = { ...signed, project: { ...signed.project, stage: 'review' } };
    expect(canPublish(regressed).ok).toBe(false);
  });

  it('treats a sign-off whose plan version no longer matches as stale', () => {
    const signed = signOff(readyWorkspace());
    const tampered: WorkspaceState = { ...signed, approval: { ...signed.approval as PlanApproval, planVersion: 'plan-00000000' } };
    const evaluation = evaluateApproval(tampered);
    expect(evaluation.status).toBe('stale');
    expect(canPublish(tampered).ok).toBe(false);
  });
});

describe('invalidateApproval', () => {
  it('marks an active sign-off stale with time and reason', () => {
    const signed = signOff(readyWorkspace());
    const invalidated = invalidateApproval(signed, 'an object was added or updated', new Date('2026-09-11T12:00:00.000Z'));
    expect(invalidated.approval?.status).toBe('stale');
    expect(invalidated.approval?.approver).toBe('Mara Chen');
    expect(invalidated.approval?.invalidatedAt).toBe('2026-09-11T12:00:00.000Z');
    expect(invalidated.approval?.invalidationReason).toBe('an object was added or updated');
    expect(evaluateApproval(invalidated)).toMatchObject({ status: 'stale', reason: 'an object was added or updated' });
  });

  it('leaves missing or already-stale sign-offs untouched', () => {
    const ready = readyWorkspace();
    expect(invalidateApproval(ready, 'anything')).toBe(ready);
    const invalidated = invalidateApproval(signOff(ready), 'first change');
    const again = invalidateApproval(invalidated, 'second change');
    expect(again).toBe(invalidated);
    expect(again.approval?.invalidationReason).toBe('first change');
  });
});
