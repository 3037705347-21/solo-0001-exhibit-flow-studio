import { describe, expect, it } from 'vitest';
import { computePlanVersion, evaluateApproval } from '../domain/approval';
import type { PlanApproval, WorkspaceState } from '../domain/models';
import { workspaceReducer } from './reducer';
import { createSeedWorkspace } from './seed';

function readyWorkspace(): WorkspaceState {
  const seed = createSeedWorkspace();
  const resolved = {
    ...seed,
    issues: seed.issues.map((issue) => issue.severity === 'critical' ? { ...issue, status: 'resolved' as const } : issue),
  };
  return workspaceReducer(resolved, { type: 'project/readiness', ready: true, checkedAt: '2026-09-11T09:00:00.000Z' });
}

function approve(state: WorkspaceState, approver = 'Mara Chen'): WorkspaceState {
  const approval: PlanApproval = {
    approver,
    approvedAt: '2026-09-11T10:00:00.000Z',
    planVersion: computePlanVersion(state),
    status: 'active',
  };
  return workspaceReducer(state, { type: 'project/approve', approval });
}

describe('lead sign-off', () => {
  it('records the approver, time, and plan version on a ready plan', () => {
    const ready = readyWorkspace();
    const signed = approve(ready);
    expect(signed.project.stage).toBe('ready');
    expect(signed.approval).toMatchObject({ approver: 'Mara Chen', approvedAt: '2026-09-11T10:00:00.000Z', status: 'active' });
    expect(signed.approval?.planVersion).toBe(computePlanVersion(ready));
    expect(evaluateApproval(signed).status).toBe('active');
  });

  it('is not disturbed by unrelated view or preference operations', () => {
    const signed = approve(readyWorkspace());
    const afterPreferences = workspaceReducer(signed, {
      type: 'preferences/update',
      preferences: { pace: 'leisurely', accessibilityPriority: 20, groupSize: 4 },
    });
    expect(evaluateApproval(afterPreferences).status).toBe('active');
    const afterRecheck = workspaceReducer(afterPreferences, { type: 'project/readiness', ready: true, checkedAt: '2026-09-11T11:00:00.000Z' });
    expect(evaluateApproval(afterRecheck).status).toBe('active');
    expect(afterRecheck.project.stage).toBe('ready');
  });

  it('is explicitly invalidated when an object changes', () => {
    const signed = approve(readyWorkspace());
    const edited = { ...signed.artifacts[0], title: 'Retitled lantern' };
    const next = workspaceReducer(signed, { type: 'artifact/upsert', artifact: edited });
    expect(next.project.stage).toBe('review');
    const evaluation = evaluateApproval(next);
    expect(evaluation.status).toBe('stale');
    if (evaluation.status === 'stale') expect(evaluation.reason).toBe('an object was added or updated');
    expect(next.approval?.invalidatedAt).toBeTruthy();
  });

  it('is explicitly invalidated when a placement changes', () => {
    const signed = approve(readyWorkspace());
    const next = workspaceReducer(signed, { type: 'placement/reorder', zoneId: 'zone-patterns', artifactId: 'artifact-radio', direction: -1 });
    expect(next.project.stage).toBe('review');
    const evaluation = evaluateApproval(next);
    expect(evaluation.status).toBe('stale');
    if (evaluation.status === 'stale') expect(evaluation.reason).toBe('the object sequence changed');
  });

  it('is explicitly invalidated when a resolved finding is reopened', () => {
    const signed = approve(readyWorkspace());
    const next = workspaceReducer(signed, {
      type: 'issue/transition',
      issueId: 'issue-quilt-light',
      status: 'in-progress',
      at: new Date('2026-09-11T12:00:00.000Z'),
    });
    expect(next.project.stage).toBe('review');
    const evaluation = evaluateApproval(next);
    expect(evaluation.status).toBe('stale');
    if (evaluation.status === 'stale') expect(evaluation.reason).toBe('a review finding changed status');
  });

  it('accepts a fresh sign-off once the plan is confirmed again', () => {
    const signed = approve(readyWorkspace());
    const changed = workspaceReducer(signed, { type: 'issue/transition', issueId: 'issue-quilt-light', status: 'in-progress' });
    expect(evaluateApproval(changed).status).toBe('stale');
    const rechecked = workspaceReducer(changed, { type: 'project/readiness', ready: true, checkedAt: '2026-09-11T13:00:00.000Z' });
    const renewed = approve(rechecked, 'Theo James');
    expect(renewed.project.stage).toBe('ready');
    expect(renewed.approval).toMatchObject({ approver: 'Theo James', status: 'active' });
    expect(renewed.approval?.invalidatedAt).toBeUndefined();
    expect(renewed.approval?.invalidationReason).toBeUndefined();
    expect(renewed.approval?.planVersion).not.toBe(signed.approval?.planVersion);
    expect(evaluateApproval(renewed).status).toBe('active');
  });
});
