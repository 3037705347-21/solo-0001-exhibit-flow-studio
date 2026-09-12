import { describe, expect, it } from 'vitest';
import { analyzeJourney } from './journeyAnalysis';
import type { WorkspaceState, Zone } from './models';
import { computePlanRevision } from './planVersion';
import {
  buildRepairProposal,
  commitRepairOperations,
  extractRepairConflicts,
  RepairCommitError,
  type RepairOperation,
} from './repairSandbox';
import { createSeedWorkspace } from '../state/seed';

function clone(state: WorkspaceState): WorkspaceState {
  return {
    ...state,
    zones: state.zones.map((zone) => ({ ...zone, artifactIds: [...zone.artifactIds] })),
    issues: state.issues.map((issue) => ({ ...issue })),
  };
}

function zoneById(state: WorkspaceState, id: string): Zone {
  const zone = state.zones.find((candidate) => candidate.id === id);
  if (!zone) throw new Error(`missing zone ${id}`);
  return zone;
}

function move(state: WorkspaceState, artifactId: string, zoneId: string): WorkspaceState {
  const next = clone(state);
  for (const zone of next.zones) zone.artifactIds = zone.artifactIds.filter((id) => id !== artifactId);
  zoneById(next, zoneId).artifactIds.push(artifactId);
  return next;
}

function unplace(state: WorkspaceState, artifactId: string): WorkspaceState {
  const next = clone(state);
  for (const zone of next.zones) zone.artifactIds = zone.artifactIds.filter((id) => id !== artifactId);
  return next;
}

/** Apply a proposal's operations without the guarded commit (test helper). */
function applyDirect(state: WorkspaceState, operations: RepairOperation[]): WorkspaceState {
  let next = clone(state);
  for (const operation of operations) {
    next = {
      ...next,
      zones: next.zones.map((zone) => ({
        ...zone,
        artifactIds: [
          ...zone.artifactIds.filter((id) => id !== operation.artifactId),
          ...(zone.id === operation.zoneId ? [operation.artifactId] : []),
        ],
      })),
    };
  }
  return next;
}

describe('repair sandbox conflict extraction', () => {
  it('lists capacity errors but ignores zone context notices', () => {
    const state = move(createSeedWorkspace(), 'artifact-tape', 'zone-arrival');
    const overloaded = move(state, 'artifact-bowl', 'zone-arrival');
    const conflicts = extractRepairConflicts(overloaded.artifacts, overloaded.zones);
    expect(conflicts.some((conflict) => conflict.kind === 'capacity' && conflict.zoneId === 'zone-arrival')).toBe(true);
    expect(conflicts.some((conflict) => conflict.id.startsWith('context-'))).toBe(false);
  });

  it('exposes seating warnings as repairable conflicts', () => {
    // Sample book needs seating and low light; arrival offers neither.
    const seatingConflict = move(createSeedWorkspace(), 'artifact-sample-book', 'zone-arrival');
    const conflicts = extractRepairConflicts(seatingConflict.artifacts, seatingConflict.zones);
    const seating = conflicts.find((conflict) => conflict.kind === 'seating');
    expect(seating).toBeDefined();
    expect(seating?.severity).toBe('warning');
  });
});

describe('repair proposal: single conflict', () => {
  it('resolves a single capacity overload with one minimal move', () => {
    let seed = createSeedWorkspace();
    seed = move(seed, 'artifact-tape', 'zone-arrival');
    const state = move(seed, 'artifact-bowl', 'zone-arrival');
    // arrival = lantern(4) + tape(5) + bowl(4) = 13/10 min
    const capacity = extractRepairConflicts(state.artifacts, state.zones).find((conflict) => conflict.kind === 'capacity');
    expect(capacity).toBeDefined();

    const proposal = buildRepairProposal({ state, selectedConflictIds: [capacity!.id] });
    expect(proposal.complete).toBe(true);
    expect(proposal.changes).toHaveLength(1);
    // The radio returns to its original Afterlives zone: one step, no new
    // blocking errors. Arrival stays at 80% (the warning threshold) afterwards,
    // which the proposal surfaces honestly as a non-blocking caution.
    expect(proposal.changes[0].operation).toMatchObject({ kind: 'move', artifactId: 'artifact-tape', zoneId: 'zone-after' });
    expect(proposal.changes[0].resolvesConflictIds).toContain(capacity!.id);
    expect(proposal.cautions.every((caution) => caution.id.startsWith('capacity-warning-') || caution.id.startsWith('density-warning-'))).toBe(true);

    const after = applyDirect(state, proposal.changes.map((change) => change.operation));
    const analysis = analyzeJourney(after.artifacts, after.zones);
    expect(analysis.findings.some((finding) => finding.id === capacity!.id)).toBe(false);
    expect(analysis.blockingCount).toBe(0);
  });

  it('documents a reason and affected materials for every change', () => {
    let seed = createSeedWorkspace();
    seed = move(seed, 'artifact-tape', 'zone-arrival');
    const state = move(seed, 'artifact-bowl', 'zone-arrival');
    const capacity = extractRepairConflicts(state.artifacts, state.zones).find((conflict) => conflict.kind === 'capacity')!;
    const proposal = buildRepairProposal({ state, selectedConflictIds: [capacity.id] });
    const change = proposal.changes[0];
    expect(change.reason.length).toBeGreaterThan(10);
    expect(change.affectedMaterials.some((material) => material.type === 'zone')).toBe(true);
    expect(change.affectedMaterials.some((material) => material.type === 'artifact')).toBe(true);
    // Seed plan has never run a readiness check, so no readiness material is listed.
    expect(change.affectedMaterials.some((material) => material.type === 'readiness')).toBe(false);
  });

  it('flags the readiness result as affected after a check has run', () => {
    let seed = createSeedWorkspace();
    seed = { ...seed, project: { ...seed.project, lastReadinessCheck: '2026-09-01T14:30:00.000Z' } };
    seed = move(seed, 'artifact-tape', 'zone-arrival');
    const state = move(seed, 'artifact-bowl', 'zone-arrival');
    const capacity = extractRepairConflicts(state.artifacts, state.zones).find((conflict) => conflict.kind === 'capacity')!;
    const proposal = buildRepairProposal({ state, selectedConflictIds: [capacity.id] });
    const readinessMaterial = proposal.changes[0].affectedMaterials.find((material) => material.type === 'readiness');
    expect(readinessMaterial).toBeDefined();
    expect(readinessMaterial?.detail).toMatch(/re-run/);
  });
});

describe('repair proposal: multiple conflicts', () => {
  it('resolves capacity and density conflicts together in one deterministic set', () => {
    let state = createSeedWorkspace();
    state = move(state, 'artifact-bowl', 'zone-arrival');
    state = move(state, 'artifact-tape', 'zone-arrival');
    state = move(state, 'artifact-gloves', 'zone-arrival');
    // arrival = lantern + bowl + tape + gloves: 4 objects (limit 3), 16/10 min
    const ids = extractRepairConflicts(state.artifacts, state.zones).map((conflict) => conflict.id);
    expect(ids).toContain('capacity-zone-arrival');
    expect(ids).toContain('density-zone-arrival');

    const proposalA = buildRepairProposal({ state, selectedConflictIds: ids });
    const proposalB = buildRepairProposal({ state, selectedConflictIds: ids });
    expect(proposalA.complete).toBe(true);
    // Deterministic: same input yields the identical ordered change set.
    expect(proposalA.changes.map((change) => JSON.stringify(change.operation))).toEqual(
      proposalB.changes.map((change) => JSON.stringify(change.operation)),
    );
    // Every selected conflict is covered by the proposal, with no duplicated operations.
    const resolved = new Set(proposalA.changes.flatMap((change) => change.resolvesConflictIds));
    for (const id of ids) expect(resolved.has(id)).toBe(true);
    const operations = proposalA.changes.map((change) => JSON.stringify(change.operation));
    expect(new Set(operations).size).toBe(operations.length);

    const after = applyDirect(state, proposalA.changes.map((change) => change.operation));
    expect(analyzeJourney(after.artifacts, after.zones).blockingCount).toBe(0);
  });

  it('resolves a capacity error and an unplaced key object together', () => {
    let state = createSeedWorkspace();
    state = unplace(state, 'artifact-quilt'); // key object back in the queue
    state = move(state, 'artifact-gloves', 'zone-arrival');
    state = move(state, 'artifact-tape', 'zone-arrival');
    // arrival = lantern + gloves + tape: 12/10 min; key quilt missing from journey
    const conflicts = extractRepairConflicts(state.artifacts, state.zones);
    const ids = conflicts
      .filter((conflict) => conflict.kind === 'capacity' || conflict.kind === 'unplaced-key')
      .map((conflict) => conflict.id);
    expect(ids.some((id) => id.startsWith('capacity-'))).toBe(true);
    expect(ids.some((id) => id.startsWith('unplaced-key-'))).toBe(true);

    const proposal = buildRepairProposal({ state, selectedConflictIds: ids });
    expect(proposal.complete).toBe(true);
    const after = applyDirect(state, proposal.changes.map((change) => change.operation));
    const analysis = analyzeJourney(after.artifacts, after.zones);
    expect(analysis.blockingCount).toBe(0);
    expect(analysis.unplacedCount).toBe(0);
  });
});

describe('repair proposal: key object protection', () => {
  it('never moves a key object and reports the unavailable option', () => {
    // Quilt (key, low-light + seating) forced into arrival: only key objects can fix it.
    const state = move(createSeedWorkspace(), 'artifact-quilt', 'zone-arrival');
    const conflicts = extractRepairConflicts(state.artifacts, state.zones);
    const light = conflicts.find((conflict) => conflict.kind === 'light' && conflict.artifactId === 'artifact-quilt');
    expect(light).toBeDefined();

    const proposal = buildRepairProposal({ state, selectedConflictIds: conflicts.map((conflict) => conflict.id) });
    expect(proposal.changes.some((change) => change.operation.artifactId === 'artifact-quilt')).toBe(false);
    expect(proposal.complete).toBe(false);
    expect(proposal.unresolvedConflictIds).toContain(light!.id);
    const blocked = proposal.blockedOptions.find((option) => option.conflictId === light!.id);
    expect(blocked?.blocked.code).toBe('key-object-protected');
    expect(blocked?.blocked.message).toMatch(/key object/i);
  });

  it('can place an unplaced key object but a proposal never returns one to the queue', () => {
    const state = unplace(createSeedWorkspace(), 'artifact-quilt');
    const conflicts = extractRepairConflicts(state.artifacts, state.zones);
    const unplacedKey = conflicts.find((conflict) => conflict.kind === 'unplaced-key' && conflict.artifactId === 'artifact-quilt');
    expect(unplacedKey).toBeDefined();
    const proposal = buildRepairProposal({ state, selectedConflictIds: [unplacedKey!.id] });
    expect(proposal.complete).toBe(true);
    expect(proposal.changes[0].operation).toMatchObject({ kind: 'place', artifactId: 'artifact-quilt', zoneId: 'zone-common' });
  });
});

describe('repair commit: versioning, failure and duplicate confirmation', () => {
  function overloadedArrival(): WorkspaceState {
    let state = createSeedWorkspace();
    state = move(state, 'artifact-tape', 'zone-arrival');
    return move(state, 'artifact-bowl', 'zone-arrival');
  }

  it('applies a proposal atomically against the original plan revision', () => {
    const state = overloadedArrival();
    const revision = computePlanRevision(state);
    const capacity = extractRepairConflicts(state.artifacts, state.zones).find((conflict) => conflict.kind === 'capacity')!;
    const proposal = buildRepairProposal({ state, selectedConflictIds: [capacity.id] });
    const next = commitRepairOperations({
      state,
      operations: proposal.changes.map((change) => change.operation),
      expectedRevision: revision,
    });
    expect(next).not.toBe(state);
    expect(analyzeJourney(next.artifacts, next.zones).blockingCount).toBe(0);
  });

  it('rejects the proposal when a placement changed since calculation', () => {
    const state = overloadedArrival();
    const revision = computePlanRevision(state);
    const capacity = extractRepairConflicts(state.artifacts, state.zones).find((conflict) => conflict.kind === 'capacity')!;
    const proposal = buildRepairProposal({ state, selectedConflictIds: [capacity.id] });

    // Plan moves on while the proposal is open...
    const drifted = move(state, 'artifact-radio', 'zone-common');
    expect(computePlanRevision(drifted)).not.toBe(revision);

    expect(() =>
      commitRepairOperations({
        state: drifted,
        operations: proposal.changes.map((change) => change.operation),
        expectedRevision: revision,
      }),
    ).toThrow(RepairCommitError);
    // ...and the drifted plan is untouched.
    expect(zoneById(drifted, 'zone-arrival').artifactIds).toEqual(
      zoneById(state, 'zone-arrival').artifactIds,
    );
  });

  it('rejects the proposal when a finding changed since calculation', () => {
    const state = overloadedArrival();
    const revision = computePlanRevision(state);
    const capacity = extractRepairConflicts(state.artifacts, state.zones).find((conflict) => conflict.kind === 'capacity')!;
    const proposal = buildRepairProposal({ state, selectedConflictIds: [capacity.id] });

    const reviewed: WorkspaceState = {
      ...state,
      issues: state.issues.map((issue) =>
        issue.id === 'issue-audio-transcript' ? { ...issue, status: 'resolved' as const } : issue,
      ),
    };
    expect(computePlanRevision(reviewed)).not.toBe(revision);
    expect(() =>
      commitRepairOperations({
        state: reviewed,
        operations: proposal.changes.map((change) => change.operation),
        expectedRevision: revision,
      }),
    ).toThrow(/recalculated/);
  });

  it('refuses a duplicate confirmation without changing the plan', () => {
    const state = overloadedArrival();
    const revision = computePlanRevision(state);
    const capacity = extractRepairConflicts(state.artifacts, state.zones).find((conflict) => conflict.kind === 'capacity')!;
    const proposal = buildRepairProposal({ state, selectedConflictIds: [capacity.id] });
    const operations = proposal.changes.map((change) => change.operation);

    const applied = commitRepairOperations({ state, operations, expectedRevision: revision });
    const appliedRevision = computePlanRevision(applied);

    // The same proposal confirmed again against the already-repaired revision.
    expect(() =>
      commitRepairOperations({ state: applied, operations, expectedRevision: appliedRevision, appliedRevision }),
    ).toThrow(/already applied/i);
    expect(zoneById(applied, 'zone-arrival').artifactIds).not.toContain('artifact-tape');
  });

  it('applies nothing when the simulation rejects an operation mid-set', () => {
    const state = overloadedArrival();
    const revision = computePlanRevision(state);
    // First move fits patterns (15/18); the second pushes it to 20/18 and must abort the whole set.
    const operations: RepairOperation[] = [
      { kind: 'move', artifactId: 'artifact-lantern', zoneId: 'zone-patterns' },
      { kind: 'move', artifactId: 'artifact-tape', zoneId: 'zone-patterns' },
    ];
    expect(() => commitRepairOperations({ state, operations, expectedRevision: revision })).toThrow(RepairCommitError);
    // The first operation was not partially committed.
    expect(zoneById(state, 'zone-arrival').artifactIds).toContain('artifact-lantern');
    expect(zoneById(state, 'zone-patterns').artifactIds).toEqual(['artifact-sample-book', 'artifact-radio']);
  });

  it('rejects empty operation sets', () => {
    const state = createSeedWorkspace();
    expect(() =>
      commitRepairOperations({ state, operations: [], expectedRevision: computePlanRevision(state) }),
    ).toThrow(/no changes/i);
  });
});

describe('plan revision', () => {
  it('is stable for equal plans and changes with placements and findings', () => {
    const state = createSeedWorkspace();
    expect(computePlanRevision(state)).toBe(computePlanRevision(clone(state)));
    expect(computePlanRevision(move(state, 'artifact-radio', 'zone-common'))).not.toBe(computePlanRevision(state));
    expect(computePlanRevision(unplace(state, 'artifact-radio'))).not.toBe(computePlanRevision(state));
    const findingChanged: WorkspaceState = {
      ...state,
      issues: state.issues.map((issue) =>
        issue.id === 'issue-entry-copy' ? { ...issue, status: 'in-progress' as const } : issue,
      ),
    };
    expect(computePlanRevision(findingChanged)).not.toBe(computePlanRevision(state));
  });
});
