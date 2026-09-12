import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RepairSandbox } from '../features/journey/RepairSandbox';
import { WorkspaceProvider, useWorkspace } from '../state/WorkspaceContext';
import { STORAGE_KEY } from '../state/persistence';
import type { WorkspaceState } from '../domain/models';
import { createSeedWorkspace } from '../state/seed';
import { buildRepairProposal, extractRepairConflicts } from '../domain/repairSandbox';
import { computePlanRevision } from '../domain/planVersion';

function overloadedPlan(): WorkspaceState {
  const plan = createSeedWorkspace();
  const move = (artifactId: string, zoneId: string) => {
    for (const zone of plan.zones) zone.artifactIds = zone.artifactIds.filter((id) => id !== artifactId);
    plan.zones.find((zone) => zone.id === zoneId)!.artifactIds.push(artifactId);
  };
  move('artifact-tape', 'zone-arrival');
  move('artifact-bowl', 'zone-arrival'); // arrival = lantern + tape + bowl = 13/10 min
  return plan;
}

function PlanEditor({ apiRef }: { apiRef: { current: ReturnType<typeof useWorkspace> | null } }) {
  const workspace = useWorkspace();
  if (apiRef.current !== workspace) apiRef.current = workspace;
  return null;
}

function renderSandbox() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overloadedPlan()));
  const onClose = vi.fn();
  const onNotify = vi.fn();
  const apiRef = createRef<ReturnType<typeof useWorkspace>>();

  render(
    <WorkspaceProvider>
      <PlanEditor apiRef={apiRef} />
      <RepairSandbox onClose={onClose} onNotify={onNotify} />
    </WorkspaceProvider>,
  );

  return {
    onClose,
    onNotify,
    workspace: () => apiRef.current!,
    injectDrift: () => act(() => {
      // Simulate another placement command landing while the proposal is open.
      // Placing an unplaced object bumps the revision without touching the
      // overloaded arrival zone, so the proposal stays applicable-but-stale.
      apiRef.current!.assignArtifact('artifact-gloves', 'zone-after');
    }),
  };
}

describe('repair sandbox modal: stale proposal lifecycle', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); });

  it('detects a plan revision change, blocks apply, then succeeds after recalculation', () => {
    const harness = renderSandbox();
    const originalRevision = computePlanRevision(harness.workspace().state);

    fireEvent.click(screen.getByRole('button', { name: /Calculate minimal changes/ }));
    expect(screen.getByRole('button', { name: /Apply 1 change to plan/ })).toBeEnabled();

    // Another placement command lands while the proposal is open; the modal
    // re-renders, detects the revision mismatch, swaps Apply for Recalculate.
    harness.injectDrift();
    expect(computePlanRevision(harness.workspace().state)).not.toBe(originalRevision);
    expect(screen.getByTestId('sandbox-stale-banner')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Apply 1 change to plan/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Recalculate from current plan/ })).toBeEnabled();
    expect(harness.onClose).not.toHaveBeenCalled();

    // Recalculate against the current plan and apply the fresh proposal once.
    fireEvent.click(screen.getByRole('button', { name: /Recalculate from current plan/ }));
    fireEvent.click(screen.getByRole('button', { name: /Apply \d+ changes? to plan/ }));
    expect(harness.onNotify).toHaveBeenCalledTimes(1);
    expect(harness.onClose).toHaveBeenCalledTimes(1);
  });

  it('does not show recalculation actions while the revision still matches', () => {
    renderSandbox();
    fireEvent.click(screen.getByRole('button', { name: /Calculate minimal changes/ }));
    expect(screen.queryByRole('button', { name: /Recalculate from current plan/ })).toBeNull();
    expect(screen.queryByTestId('sandbox-stale-banner')).toBeNull();
  });

  it('recomputing is deterministic against the current plan revision', () => {
    const plan = overloadedPlan();
    const capacity = extractRepairConflicts(plan.artifacts, plan.zones).find((conflict) => conflict.kind === 'capacity')!;
    const first = buildRepairProposal({ state: plan, selectedConflictIds: [capacity.id] });
    const second = buildRepairProposal({ state: plan, selectedConflictIds: [capacity.id] });
    expect(first.revision).toBe(computePlanRevision(plan));
    expect(second.changes.map((change) => JSON.stringify(change.operation))).toEqual(
      first.changes.map((change) => JSON.stringify(change.operation)),
    );
  });
});
