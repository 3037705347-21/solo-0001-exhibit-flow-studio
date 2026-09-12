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
