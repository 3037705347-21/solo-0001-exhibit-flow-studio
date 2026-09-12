import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, beforeEach } from 'vitest';
import { analyzeJourney } from '../domain/journeyAnalysis';
import { computePlanRevision } from '../domain/planVersion';
import { buildRepairProposal, extractRepairConflicts } from '../domain/repairSandbox';
import type { WorkspaceState } from '../domain/models';
import { STORAGE_KEY } from './persistence';
import { createSeedWorkspace } from './seed';
import { WorkspaceProvider, useWorkspace } from './WorkspaceContext';

function overloadedPlan(): WorkspaceState {
  const plan = createSeedWorkspace();
  const move = (artifactId: string, zoneId: string) => {
    for (const zone of plan.zones) zone.artifactIds = zone.artifactIds.filter((id) => id !== artifactId);
    plan.zones.find((zone) => zone.id === zoneId)!.artifactIds.push(artifactId);
  };
  move('artifact-tape', 'zone-arrival');
  move('artifact-bowl', 'zone-arrival');
  return plan; // lantern + tape + bowl in arrival = 13/10 min
}

function renderWorkspace() {
  const wrapper = ({ children }: { children: import('react').ReactNode }) => <WorkspaceProvider>{children}</WorkspaceProvider>;
  return renderHook(() => useWorkspace(), { wrapper });
}

describe('repair command boundary', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  function proposalFor(state: WorkspaceState) {
    const capacity = extractRepairConflicts(state.artifacts, state.zones).find((conflict) => conflict.kind === 'capacity')!;
    return buildRepairProposal({ state, selectedConflictIds: [capacity.id] });
  }

  it('applies a proposal once, then rejects a repeat confirmation without polluting the plan', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overloadedPlan()));
    const { result } = renderWorkspace();

    const before = result.current.state;
    expect(analyzeJourney(before.artifacts, before.zones).blockingCount).toBeGreaterThan(0);
    const proposal = proposalFor(before);

    let response: { ok: boolean; message?: string } = { ok: false };
    act(() => { response = result.current.applyRepairProposal(proposal.changes.map((change) => change.operation), proposal.revision); });
    expect(response.ok).toBe(true);

    const applied = result.current.state;
    expect(analyzeJourney(applied.artifacts, applied.zones).blockingCount).toBe(0);
    const arrival = applied.zones.find((zone) => zone.id === 'zone-arrival')!;
    expect(arrival.artifactIds).not.toContain('artifact-tape');
    // Confirming the same proposal again (e.g. a second click or a stale view)
    // must not move anything further.
    const arrivalSnapshot = [...arrival.artifactIds];
    let repeat: { ok: boolean; message?: string } = { ok: true };
    act(() => { repeat = result.current.applyRepairProposal(proposal.changes.map((change) => change.operation), proposal.revision); });
    expect(repeat.ok).toBe(false);
    expect(repeat.message).toMatch(/already applied/i);
    const afterRepeat = result.current.state.zones.find((zone) => zone.id === 'zone-arrival')!;
    expect(afterRepeat.artifactIds).toEqual(arrivalSnapshot);
    expect(computePlanRevision(result.current.state)).toBe(computePlanRevision(applied));
  });

  it('applies a second, different proposal for remaining conflicts after the first repair', () => {
    // Regression: the first successful repair must not poison later repairs.
    // Only an identical revision+operations confirmation is a duplicate.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overloadedPlan()));
    const { result } = renderWorkspace();

    // First repair: select just the capacity error and apply it.
    const first = proposalFor(result.current.state);
    let response: { ok: boolean; message?: string } = { ok: false };
    act(() => { response = result.current.applyRepairProposal(first.changes.map((change) => change.operation), first.revision); });
    expect(response.ok).toBe(true);
    const afterFirst = result.current.state;
    expect(computePlanRevision(afterFirst)).not.toBe(first.revision);

    // The repaired plan still carries a non-blocking capacity warning. Build a
    // second proposal for the remaining conflicts against the new revision.
    const remaining = extractRepairConflicts(afterFirst.artifacts, afterFirst.zones);
    expect(remaining.length).toBeGreaterThan(0);
    const second = buildRepairProposal({
      state: afterFirst,
      selectedConflictIds: remaining.map((conflict) => conflict.id),
    });
    expect(second.revision).toBe(computePlanRevision(afterFirst));
    expect(JSON.stringify(second.changes.map((change) => change.operation)))
      .not.toBe(JSON.stringify(first.changes.map((change) => change.operation)));

    act(() => {
      response = result.current.applyRepairProposal(second.changes.map((change) => change.operation), second.revision);
    });
    // The second proposal is a fresh confirmation, not a duplicate.
    expect(response.ok).toBe(true);
    expect(response.message).toBeUndefined();
  });

  it('still rejects an identical duplicate of the second proposal once applied', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overloadedPlan()));
    const { result } = renderWorkspace();

    const first = proposalFor(result.current.state);
    act(() => { result.current.applyRepairProposal(first.changes.map((change) => change.operation), first.revision); });

    const remaining = extractRepairConflicts(result.current.state.artifacts, result.current.state.zones);
    const second = buildRepairProposal({
      state: result.current.state,
      selectedConflictIds: remaining.map((conflict) => conflict.id),
    });
    const secondOperations = second.changes.map((change) => change.operation);
    act(() => { result.current.applyRepairProposal(secondOperations, second.revision); });

    const revisionAfterSecond = computePlanRevision(result.current.state);
    const arrivalAfterSecond = [...result.current.state.zones.find((zone) => zone.id === 'zone-arrival')!.artifactIds];

    // Re-confirming the exact same second proposal (same revision + operations)
    // is rejected even though that revision has already moved on.
    let duplicate: { ok: boolean; message?: string } = { ok: true };
    act(() => {
      duplicate = result.current.applyRepairProposal(secondOperations, second.revision);
    });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.message).toMatch(/already applied|recalculated/i);
    expect(computePlanRevision(result.current.state)).toBe(revisionAfterSecond);
    expect(result.current.state.zones.find((zone) => zone.id === 'zone-arrival')!.artifactIds).toEqual(arrivalAfterSecond);
  });

  it('abandons a stale proposal when a placement changed, then succeeds after recalculation', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overloadedPlan()));
    const { result } = renderWorkspace();

    const original = result.current.state;
    const proposal = proposalFor(original);

    // Another placement command lands before the user confirms.
    act(() => { result.current.assignArtifact('artifact-gloves', 'zone-after'); });
    const drifted = result.current.state;
    expect(computePlanRevision(drifted)).not.toBe(proposal.revision);
    const driftedArrival = [...drifted.zones.find((zone) => zone.id === 'zone-arrival')!.artifactIds];

    // The stale proposal is rejected and nothing is written...
    let response: { ok: boolean; message?: string } = { ok: true };
    act(() => { response = result.current.applyRepairProposal(proposal.changes.map((change) => change.operation), proposal.revision); });
    expect(response.ok).toBe(false);
    expect(response.message).toMatch(/recalculated/);
    expect(result.current.state.zones.find((zone) => zone.id === 'zone-arrival')!.artifactIds).toEqual(driftedArrival);

    // ...recalculate against the current plan and confirm the fresh set.
    const fresh = proposalFor(result.current.state);
    expect(fresh.revision).toBe(computePlanRevision(result.current.state));
    act(() => {
      response = result.current.applyRepairProposal(fresh.changes.map((change) => change.operation), fresh.revision);
    });
    expect(response.ok).toBe(true);
    expect(analyzeJourney(result.current.state.artifacts, result.current.state.zones).blockingCount).toBe(0);
  });

  it('abandons a stale proposal when a finding changed', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overloadedPlan()));
    const { result } = renderWorkspace();
    const proposal = proposalFor(result.current.state);

    act(() => { result.current.transitionReviewIssue('issue-entry-copy', 'in-progress'); });
    expect(computePlanRevision(result.current.state)).not.toBe(proposal.revision);

    let response: { ok: boolean; message?: string } = { ok: true };
    act(() => { response = result.current.applyRepairProposal(proposal.changes.map((change) => change.operation), proposal.revision); });
    expect(response.ok).toBe(false);
    expect(response.message).toMatch(/recalculated/);
    // The placement the stale proposal would have changed is still in arrival.
    expect(result.current.state.zones.find((zone) => zone.id === 'zone-arrival')!.artifactIds).toContain('artifact-bowl');
  });

  it('closing or reopening without confirming never writes to the plan', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overloadedPlan()));
    const { result } = renderWorkspace();
    const startingRevision = computePlanRevision(result.current.state);

    // Build proposals repeatedly (as opening/closing the modal would) without confirming.
    for (let i = 0; i < 3; i += 1) {
      proposalFor(result.current.state);
    }
    expect(computePlanRevision(result.current.state)).toBe(startingRevision);
    expect(analyzeJourney(result.current.state.artifacts, result.current.state.zones).blockingCount).toBeGreaterThan(0);
  });
});
