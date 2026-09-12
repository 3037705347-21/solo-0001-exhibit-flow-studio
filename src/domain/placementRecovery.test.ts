import { describe, expect, it } from 'vitest';
import type { Artifact, PlacementRemoval, SnapshotPublication, WorkspaceState, Zone } from './models';
import { createSeedWorkspace } from '../state/seed';
import {
  RESTORE_CONFLICT_LABELS,
  applyPlacementRemoval,
  createPlacementRemoval,
  evaluateRestore,
  planPlacementRemoval,
  pruneRestoredRemovals,
  resolveRestoreIndex,
} from './placementRecovery';

const REMOVED_AT = new Date('2026-09-10T10:00:00.000Z');
const RESTORED_AT = new Date('2026-09-11T10:00:00.000Z');

function seeded(): WorkspaceState {
  return createSeedWorkspace();
}

function removeQuilt(state: WorkspaceState, at = REMOVED_AT): { state: WorkspaceState; removal: PlacementRemoval } {
  const removal = createPlacementRemoval(state, 'artifact-quilt', 'removal-quilt', at)!;
  expect(removal).toBeTruthy();
  return { state: applyPlacementRemoval(state, removal), removal };
}

function restore(state: WorkspaceState, removalId: string, at = RESTORED_AT) {
  return evaluateRestore(state, removalId, at);
}

function findZone(state: WorkspaceState, zoneId: string): Zone {
  return state.zones.find((zone) => zone.id === zoneId)!;
}

describe('planPlacementRemoval', () => {
  it('captures source placement, neighbors, findings and export dependencies before removal', () => {
    let state = seeded();
    state = {
      ...state,
      publications: [{
        generatedAt: '2026-09-01T09:00:00.000Z',
        fileName: 'exhibit-flow-snapshot-2026-09-01.json',
        readinessScore: 88,
        zoneIds: ['zone-common'],
        artifactIds: ['artifact-press', 'artifact-quilt'],
      }],
    };
    const plan = planPlacementRemoval(state, 'artifact-quilt')!;
    expect(plan.zoneId).toBe('zone-common');
    expect(plan.index).toBe(1);
    expect(plan.neighborBeforeTitle).toBe('Portable Letterpress');
    expect(plan.neighborAfterTitle).toBeNull();
    // quilt carries a resolved zone/object finding in seed
    expect(plan.relatedFindings.some((finding) => finding.issueId === 'issue-quilt-light')).toBe(true);
    expect(plan.exportDependencies).toHaveLength(1);
    expect(plan.exportDependencies[0].readinessScore).toBe(88);
  });

  it('returns null for an unplaced object', () => {
    // every seed artifact is placed; build a state with an extra unplaced one
    const state = seeded();
    const extra: Artifact = { ...state.artifacts[0], id: 'artifact-loose', accessionId: 'AF-2000-001' };
    const withExtra: WorkspaceState = { ...state, artifacts: [...state.artifacts, extra] };
    expect(planPlacementRemoval(withExtra, 'artifact-loose')).toBeNull();
  });
});

describe('placement removal recovery', () => {
  it('restores an object to its deterministic slot in the ordinary case', () => {
    const removed = removeQuilt(seeded());
    expect(findZone(removed.state, 'zone-common').artifactIds).toEqual(['artifact-press']);

    const { outcome, next } = restore(removed.state, removed.removal.id);
    expect(outcome.kind).toBe('restored');
    const zone = findZone(next, 'zone-common');
    expect(zone.artifactIds).toEqual(['artifact-press', 'artifact-quilt']);
    const record = next.removals[0];
    expect(record.status).toBe('restored');
    expect(record.restoredAt).toBe(RESTORED_AT.toISOString());
    expect(record.conflictReason).toBeUndefined();
  });

  it('uses the recorded neighbors when objects shifted elsewhere after removal', () => {
    // Three compatible objects in one zone; remove the middle one. The
    // recorded neighbors stay adjacent, so the return slot is deterministic.
    let state = seeded();
    state = {
      ...state,
      zones: state.zones.map((zone) =>
        zone.id === 'zone-common'
          ? { ...zone, capacityMinutes: 30, artifactIds: ['artifact-press', 'artifact-sample-book', 'artifact-quilt'] }
          : { ...zone, artifactIds: zone.artifactIds.filter((id) => id !== 'artifact-sample-book') },
      ),
    };
    const removal = createPlacementRemoval(state, 'artifact-sample-book', 'removal-book', REMOVED_AT)!;
    expect(removal.neighborBeforeId).toBe('artifact-press');
    expect(removal.neighborAfterId).toBe('artifact-quilt');
    const removedState = applyPlacementRemoval(state, removal);
    expect(findZone(removedState, 'zone-common').artifactIds).toEqual(['artifact-press', 'artifact-quilt']);

    const slot = resolveRestoreIndex(findZone(removedState, 'zone-common'), removal);
    expect(slot).toEqual({ index: 1 });
    const result = restore(removedState, removal.id);
    expect(result.outcome.kind).toBe('restored');
    expect(findZone(result.next, 'zone-common').artifactIds).toEqual(['artifact-press', 'artifact-sample-book', 'artifact-quilt']);
  });

  it('holds the record for review on a position conflict instead of overwriting the sequence', () => {
    // After removing the middle object, a newcomer is inserted between the two
    // recorded anchors: the slot is no longer derivable.
    let state = seeded();
    state = {
      ...state,
      zones: state.zones.map((zone) =>
        zone.id === 'zone-common'
          ? { ...zone, capacityMinutes: 30, artifactIds: ['artifact-press', 'artifact-sample-book', 'artifact-quilt'] }
          : { ...zone, artifactIds: zone.artifactIds.filter((id) => id !== 'artifact-sample-book') },
      ),
    };
    const bookRemoval = createPlacementRemoval(state, 'artifact-sample-book', 'removal-book-conflict', REMOVED_AT)!;
    const removedState = applyPlacementRemoval(state, bookRemoval);
    const intruder: Artifact = {
      ...removedState.artifacts[0],
      id: 'artifact-intruder',
      accessionId: 'AF-2000-003',
      title: 'Newcomer Vessel',
      sensitivity: 'low-light',
      accessibilityNeed: 'none',
      dwellMinutes: 2,
    };
    let next: WorkspaceState = { ...removedState, artifacts: [...removedState.artifacts, intruder] };
    next = {
      ...next,
      zones: next.zones.map((zone) =>
        zone.id === 'zone-common'
          ? { ...zone, artifactIds: ['artifact-press', 'artifact-intruder', 'artifact-quilt'] }
          : zone,
      ),
    };
    const { outcome, next: reviewed } = restore(next, bookRemoval.id);
    expect(outcome.kind).toBe('review');
    expect(outcome.reason).toBe('position-ambiguous');
    // The record is preserved for review, and no placement was written.
    expect(findZone(reviewed, 'zone-common').artifactIds).toEqual(['artifact-press', 'artifact-intruder', 'artifact-quilt']);
    const record = reviewed.removals.find((candidate) => candidate.id === bookRemoval.id)!;
    expect(record.status).toBe('in-review');
    expect(record.conflictReason).toBe('position-ambiguous');
    expect(record.reviewAttempts).toBe(1);
    expect(RESTORE_CONFLICT_LABELS[record.conflictReason!]).toBeTruthy();
  });

  it('routes to review when the object was modified after removal', () => {
    const removed = removeQuilt(seeded());
    const changedQuilt: Artifact = {
      ...removed.state.artifacts.find((artifact) => artifact.id === 'artifact-quilt')!,
      dwellMinutes: 12,
      updatedAt: '2026-09-10T18:00:00.000Z',
    };
    const next: WorkspaceState = {
      ...removed.state,
      artifacts: removed.state.artifacts.map((artifact) => (artifact.id === changedQuilt.id ? changedQuilt : artifact)),
    };
    const { outcome, next: reviewed } = restore(next, removed.removal.id);
    expect(outcome.kind).toBe('review');
    expect(outcome.reason).toBe('object-modified');
    expect(findZone(reviewed, 'zone-common').artifactIds).toEqual(['artifact-press']);
    expect(reviewed.removals[0].status).toBe('in-review');
  });

  it('makes a repeated restore a no-op and never duplicates the placement', () => {
    const removed = removeQuilt(seeded());
    const first = restore(removed.state, removed.removal.id);
    expect(first.outcome.kind).toBe('restored');
    expect(findZone(first.next, 'zone-common').artifactIds).toEqual(['artifact-press', 'artifact-quilt']);

    const second = restore(first.next, removed.removal.id, new Date('2026-09-12T10:00:00.000Z'));
    expect(second.outcome.kind).toBe('noop');
    expect(second.next).toBe(first.next);
    expect(findZone(second.next, 'zone-common').artifactIds).toEqual(['artifact-press', 'artifact-quilt']);
  });

  it('holds for review when a snapshot published after removal invalidates the export dependency', () => {
    const removed = removeQuilt(seeded());
    const publication: SnapshotPublication = {
      generatedAt: '2026-09-10T12:00:00.000Z',
      fileName: 'exhibit-flow-snapshot-2026-09-10.json',
      readinessScore: 92,
      zoneIds: ['zone-common'],
      artifactIds: ['artifact-press'],
    };
    const next: WorkspaceState = { ...removed.state, publications: [publication] };
    const { outcome, next: reviewed } = restore(next, removed.removal.id);
    expect(outcome.kind).toBe('review');
    expect(outcome.reason).toBe('export-dependency-stale');
    // The published record is left completely untouched.
    expect(reviewed.publications).toEqual([publication]);
    expect(findZone(reviewed, 'zone-common').artifactIds).toEqual(['artifact-press']);
  });

  it('ignores publications that predate the removal', () => {
    let state = seeded();
    state = {
      ...state,
      publications: [{
        generatedAt: '2026-09-01T09:00:00.000Z',
        fileName: 'exhibit-flow-snapshot-2026-09-01.json',
        readinessScore: 70,
        zoneIds: ['zone-common'],
        artifactIds: ['artifact-press', 'artifact-quilt'],
      }],
    };
    const removed = removeQuilt(state);
    const { outcome } = restore(removed.state, removed.removal.id);
    expect(outcome.kind).toBe('restored');
  });

  it('holds for review when restoring would violate current exhibition constraints', () => {
    const removed = removeQuilt(seeded());
    // Shrink the zone so re-adding the 8-minute quilt breaches dwell capacity.
    const next: WorkspaceState = {
      ...removed.state,
      zones: removed.state.zones.map((zone) =>
        zone.id === 'zone-common' ? { ...zone, capacityMinutes: 7 } : zone,
      ),
    };
    const { outcome, next: reviewed } = restore(next, removed.removal.id);
    expect(outcome.kind).toBe('review');
    expect(outcome.reason).toBe('constraint-violation');
    expect(findZone(reviewed, 'zone-common').artifactIds).toEqual(['artifact-press']);
  });

  it('holds for review when the object was manually placed elsewhere meanwhile', () => {
    const removed = removeQuilt(seeded());
    const next: WorkspaceState = {
      ...removed.state,
      zones: removed.state.zones.map((zone) =>
        zone.id === 'zone-after' ? { ...zone, artifactIds: [...zone.artifactIds, 'artifact-quilt'] } : zone,
      ),
    };
    const { outcome, next: reviewed } = restore(next, removed.removal.id);
    expect(outcome.kind).toBe('review');
    expect(outcome.reason).toBe('already-placed');
    expect(findZone(reviewed, 'zone-after').artifactIds).toContain('artifact-quilt');
    expect(findZone(reviewed, 'zone-common').artifactIds).toEqual(['artifact-press']);
  });

  it('keeps the record for review when the object or zone was deleted', () => {
    const removed = removeQuilt(seeded());
    const objectDeleted: WorkspaceState = {
      ...removed.state,
      artifacts: removed.state.artifacts.filter((artifact) => artifact.id !== 'artifact-quilt'),
    };
    const objectResult = restore(objectDeleted, removed.removal.id);
    expect(objectResult.outcome.reason).toBe('object-missing');
    expect(objectResult.next.removals[0].status).toBe('in-review');

    const zoneDeleted: WorkspaceState = {
      ...removed.state,
      zones: removed.state.zones.filter((zone) => zone.id !== 'zone-common'),
    };
    const zoneResult = restore(zoneDeleted, removed.removal.id);
    expect(zoneResult.outcome.reason).toBe('zone-missing');
  });

  it('accepts curator sign-off for an object-modified record but still honors hard checks', () => {
    const removed = removeQuilt(seeded());
    const changedQuilt: Artifact = {
      ...removed.state.artifacts.find((artifact) => artifact.id === 'artifact-quilt')!,
      summary: 'Curator added a revised interpretation note.',
      updatedAt: '2026-09-10T18:00:00.000Z',
    };
    const next: WorkspaceState = {
      ...removed.state,
      artifacts: removed.state.artifacts.map((artifact) => (artifact.id === changedQuilt.id ? changedQuilt : artifact)),
    };
    const blocked = restore(next, removed.removal.id);
    expect(blocked.outcome.kind).toBe('review');
    const signedOff = evaluateRestore(blocked.next, removed.removal.id, RESTORED_AT, { approved: true });
    expect(signedOff.outcome.kind).toBe('restored');
    expect(findZone(signedOff.next, 'zone-common').artifactIds).toEqual(['artifact-press', 'artifact-quilt']);
    expect(signedOff.outcome.detail).toMatch(/review sign-off/);
  });

  it('rejects sign-off when the edited object now violates a hard constraint', () => {
    const removed = removeQuilt(seeded());
    const invalidQuilt: Artifact = {
      ...removed.state.artifacts.find((artifact) => artifact.id === 'artifact-quilt')!,
      sensitivity: 'standard',
      // Make the dwell so large it blows the zone capacity.
      dwellMinutes: 60,
      updatedAt: '2026-09-10T18:00:00.000Z',
    };
    const next: WorkspaceState = {
      ...removed.state,
      artifacts: removed.state.artifacts.map((artifact) => (artifact.id === invalidQuilt.id ? invalidQuilt : artifact)),
    };
    const firstReview = restore(next, removed.removal.id);
    expect(firstReview.outcome.kind).toBe('review');
    const signedOff = evaluateRestore(firstReview.next, removed.removal.id, RESTORED_AT, { approved: true });
    expect(signedOff.outcome.kind).toBe('review');
    expect(signedOff.outcome.reason).toBe('constraint-violation');
    expect(findZone(signedOff.next, 'zone-common').artifactIds).toEqual(['artifact-press']);
  });

  it('cannot use sign-off to overwrite an ambiguous position or an existing placement', () => {
    let state = seeded();
    state = {
      ...state,
      zones: state.zones.map((zone) =>
        zone.id === 'zone-common'
          ? { ...zone, capacityMinutes: 30, artifactIds: ['artifact-press', 'artifact-sample-book', 'artifact-quilt'] }
          : { ...zone, artifactIds: zone.artifactIds.filter((id) => id !== 'artifact-sample-book') },
      ),
    };
    const bookRemoval = createPlacementRemoval(state, 'artifact-sample-book', 'removal-book-signoff', REMOVED_AT)!;
    const removedState = applyPlacementRemoval(state, bookRemoval);
    const intruder: Artifact = { ...removedState.artifacts[0], id: 'artifact-intruder', accessionId: 'AF-2000-009', sensitivity: 'low-light', dwellMinutes: 2 };
    let next: WorkspaceState = { ...removedState, artifacts: [...removedState.artifacts, intruder] };
    next = {
      ...next,
      zones: next.zones.map((zone) =>
        zone.id === 'zone-common'
          ? { ...zone, artifactIds: ['artifact-press', 'artifact-intruder', 'artifact-quilt'] }
          : zone,
      ),
    };
    // First attempt moves the record to review.
    const reviewed = evaluateRestore(next, bookRemoval.id);
    expect(reviewed.outcome.reason).toBe('position-ambiguous');
    const forced = evaluateRestore(reviewed.next, bookRemoval.id, RESTORED_AT, { approved: true });
    expect(forced.outcome.kind).toBe('review');
    expect(forced.outcome.reason).toBe('position-ambiguous');
    expect(findZone(forced.next, 'zone-common').artifactIds).toEqual(['artifact-press', 'artifact-intruder', 'artifact-quilt']);
  });

  it('returns a zone-only object to index 0 while the zone stays empty', () => {
    // The lantern is the only object in zone-arrival, so it has no anchors.
    const state = seeded();
    const removal = createPlacementRemoval(state, 'artifact-lantern', 'removal-lantern', REMOVED_AT)!;
    expect(removal.neighborBeforeId).toBeNull();
    expect(removal.neighborAfterId).toBeNull();
    expect(removal.zoneOrderAfterRemoval).toEqual([]);
    const removedState = applyPlacementRemoval(state, removal);
    expect(findZone(removedState, 'zone-arrival').artifactIds).toEqual([]);

    const slot = resolveRestoreIndex(findZone(removedState, 'zone-arrival'), removal);
    expect(slot).toEqual({ index: 0 });
    const result = restore(removedState, removal.id);
    expect(result.outcome.kind).toBe('restored');
    expect(findZone(result.next, 'zone-arrival').artifactIds).toEqual(['artifact-lantern']);
  });

  it('holds a zone-only removal for review when objects were added to the anchorless zone', () => {
    // After the only object leaves, the gloves (standard light, no seating
    // need) are placed into the now-empty arrival zone.
    const state = seeded();
    const removal = createPlacementRemoval(state, 'artifact-lantern', 'removal-lantern-conflict', REMOVED_AT)!;
    const removedState = applyPlacementRemoval(state, removal);
    const next: WorkspaceState = {
      ...removedState,
      zones: removedState.zones.map((zone) =>
        zone.id === 'zone-arrival' ? { ...zone, artifactIds: ['artifact-gloves'] } : zone,
      ),
    };

    const slot = resolveRestoreIndex(findZone(next, 'zone-arrival'), removal);
    expect(slot).toEqual({ ambiguous: true });

    const { outcome, next: reviewed } = restore(next, removal.id);
    expect(outcome.kind).toBe('review');
    expect(outcome.reason).toBe('position-ambiguous');
    // The newcomer stays untouched, no blind insertion at index 0, and the
    // original record is preserved for review.
    expect(findZone(reviewed, 'zone-arrival').artifactIds).toEqual(['artifact-gloves']);
    const record = reviewed.removals.find((candidate) => candidate.id === removal.id)!;
    expect(record.status).toBe('in-review');
    expect(record.conflictReason).toBe('position-ambiguous');
    expect(record.reviewAttempts).toBe(1);

    // Curator sign-off cannot invent a position either: this is a hard check.
    const forced = evaluateRestore(reviewed, removal.id, RESTORED_AT, { approved: true });
    expect(forced.outcome.kind).toBe('review');
    expect(forced.outcome.reason).toBe('position-ambiguous');
    expect(findZone(forced.next, 'zone-arrival').artifactIds).toEqual(['artifact-gloves']);
  });

  it('allows re-evaluation after the conflict is resolved manually', () => {    const removed = removeQuilt(seeded());
    const originalCapacity = findZone(removed.state, 'zone-common').capacityMinutes;
    const shrunk: WorkspaceState = {
      ...removed.state,
      zones: removed.state.zones.map((zone) =>
        zone.id === 'zone-common' ? { ...zone, capacityMinutes: 7 } : zone,
      ),
    };
    const blocked = restore(shrunk, removed.removal.id);
    expect(blocked.outcome.kind).toBe('review');
    // Capacity restored to what the record captured: the retry clears review.
    const fixed: WorkspaceState = {
      ...blocked.next,
      zones: blocked.next.zones.map((zone) =>
        zone.id === 'zone-common' ? { ...zone, capacityMinutes: originalCapacity } : zone,
      ),
    };
    const retried = restore(fixed, removed.removal.id);
    expect(retried.outcome.kind).toBe('restored');
    expect(findZone(retried.next, 'zone-common').artifactIds).toEqual(['artifact-press', 'artifact-quilt']);
  });

  it('prunes only the oldest restored records and keeps every open record', () => {
    const removed = removeQuilt(seeded());
    const makeRecord = (id: string, status: PlacementRemoval['status'], restoredAt?: string): PlacementRemoval => ({
      ...removed.removal,
      id,
      status,
      restoredAt,
      conflictReason: status === 'in-review' ? 'position-ambiguous' : undefined,
    });
    const records: PlacementRemoval[] = [
      makeRecord('held-1', 'held'),
      ...Array.from({ length: 22 }, (_unused, index) =>
        makeRecord(`restored-${index}`, 'restored', new Date(Date.UTC(2026, 8, index + 1)).toISOString()),
      ),
      makeRecord('review-1', 'in-review'),
    ];
    const pruned = pruneRestoredRemovals(records, 20);
    expect(pruned.some((record) => record.id === 'held-1')).toBe(true);
    expect(pruned.some((record) => record.id === 'review-1')).toBe(true);
    expect(pruned.filter((record) => record.status === 'restored')).toHaveLength(20);
    // The two oldest restored records are the ones dropped.
    expect(pruned.some((record) => record.id === 'restored-0')).toBe(false);
    expect(pruned.some((record) => record.id === 'restored-1')).toBe(false);
    expect(pruned.some((record) => record.id === 'restored-2')).toBe(true);
  });
});
