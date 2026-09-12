import { describe, expect, it } from 'vitest';
import {
  applyPlacementCandidates,
  evaluateBatchPlacement,
  placementFingerprint,
  stageBatchPlacement,
  type PlacementCandidate,
} from './batchPlacement';
import type { WorkspaceState } from './models';
import { createSeedWorkspace } from '../state/seed';

function unplace(state: WorkspaceState, ...artifactIds: string[]): WorkspaceState {
  return {
    ...state,
    zones: state.zones.map((zone) => ({
      ...zone,
      artifactIds: zone.artifactIds.filter((id) => !artifactIds.includes(id)),
    })),
  };
}

function evaluate(candidates: PlacementCandidate[], state: WorkspaceState = createSeedWorkspace()) {
  return evaluateBatchPlacement(state, stageBatchPlacement(state, candidates, 'batch-test'));
}

describe('evaluateBatchPlacement', () => {
  it('approves a feasible batch and projects the resulting zone load', () => {
    const evaluation = evaluate([{ artifactId: 'artifact-gloves', zoneId: 'zone-arrival' }]);
    expect(evaluation.canApply).toBe(true);
    expect(evaluation.readyCount).toBe(1);
    expect(evaluation.blockedCount).toBe(0);
    expect(evaluation.tradeoffCount).toBe(0);
    expect(evaluation.roleGaps).toEqual([]);
    expect(evaluation.keyObjectGaps).toEqual([]);
    const arrival = evaluation.zoneSummaries.find((summary) => summary.zoneId === 'zone-arrival')!;
    expect(arrival.resultingObjects).toBe(2);
    expect(arrival.resultingMinutes).toBe(7);
    expect(arrival.overCapacity).toBe(false);
  });

  it('blocks candidates that would push a zone over its object limit', () => {
    const evaluation = evaluate([
      { artifactId: 'artifact-gloves', zoneId: 'zone-arrival' },
      { artifactId: 'artifact-radio', zoneId: 'zone-arrival' },
      { artifactId: 'artifact-tape', zoneId: 'zone-arrival' },
    ]);
    expect(evaluation.canApply).toBe(false);
    expect(evaluation.blockedCount).toBe(3);
    for (const assessment of evaluation.assessments) {
      expect(assessment.verdict).toBe('blocked');
      expect(assessment.reasons.some((reason) => reason.includes('limit of 3'))).toBe(true);
    }
  });

  it('blocks candidates that would exceed dwell capacity', () => {
    const evaluation = evaluate([
      { artifactId: 'artifact-gloves', zoneId: 'zone-arrival' },
      { artifactId: 'artifact-tape', zoneId: 'zone-arrival' },
    ]);
    expect(evaluation.canApply).toBe(false);
    expect(evaluation.blockedCount).toBe(2);
    const gloves = evaluation.assessments.find((assessment) => assessment.candidate.artifactId === 'artifact-gloves')!;
    expect(gloves.reasons.some((reason) => reason.includes('exceed its dwell capacity'))).toBe(true);
  });

  it('reports narrative role gaps that remain after the batch', () => {
    const state = unplace(createSeedWorkspace(), 'artifact-bowl', 'artifact-tape');
    const evaluation = evaluate([{ artifactId: 'artifact-radio', zoneId: 'zone-arrival' }], state);
    expect(evaluation.roleGaps).toEqual(['reflection']);
    expect(evaluation.canApply).toBe(true);
  });

  it('reports key objects that remain unplaced after the batch', () => {
    const state = unplace(createSeedWorkspace(), 'artifact-quilt');
    const evaluation = evaluate([{ artifactId: 'artifact-gloves', zoneId: 'zone-arrival' }], state);
    expect(evaluation.keyObjectGaps).toEqual(['artifact-quilt']);
  });

  it('blocks low-light objects assigned to a standard-light zone', () => {
    const evaluation = evaluate([{ artifactId: 'artifact-sample-book', zoneId: 'zone-arrival' }]);
    const assessment = evaluation.assessments[0];
    expect(assessment.verdict).toBe('blocked');
    expect(assessment.reasons.some((reason) => reason.includes('low-light'))).toBe(true);
    expect(evaluation.canApply).toBe(false);
  });

  it('flags seating needs as a trade-off, not a blocker', () => {
    const seed = createSeedWorkspace();
    const state = {
      ...seed,
      artifacts: seed.artifacts.map((artifact) =>
        artifact.id === 'artifact-gloves' ? { ...artifact, accessibilityNeed: 'seating' as const } : artifact),
    };
    const evaluation = evaluate([{ artifactId: 'artifact-gloves', zoneId: 'zone-arrival' }], state);
    const gloves = evaluation.assessments[0];
    expect(gloves.verdict).toBe('tradeoff');
    expect(gloves.reasons.some((reason) => reason.includes('seated interpretation'))).toBe(true);
    expect(evaluation.canApply).toBe(true);
  });

  it('flags relocations and near-capacity zones as trade-offs', () => {
    const evaluation = evaluate([{ artifactId: 'artifact-radio', zoneId: 'zone-arrival' }]);
    const radio = evaluation.assessments[0];
    expect(radio.verdict).toBe('tradeoff');
    expect(radio.reasons.some((reason) => reason.includes('Moves the object out of Patterns of Work'))).toBe(true);
    expect(radio.reasons.some((reason) => reason.includes('90% of its dwell capacity'))).toBe(true);
    expect(evaluation.tradeoffCount).toBe(1);
    expect(evaluation.canApply).toBe(true);
  });

  it('blocks duplicate candidates for the same object', () => {
    const evaluation = evaluate([
      { artifactId: 'artifact-gloves', zoneId: 'zone-arrival' },
      { artifactId: 'artifact-gloves', zoneId: 'zone-patterns' },
    ]);
    expect(evaluation.blockedCount).toBe(2);
    expect(evaluation.assessments[0].reasons.some((reason) => reason.includes('more than once'))).toBe(true);
  });

  it('blocks candidates referencing missing objects or zones', () => {
    const evaluation = evaluate([
      { artifactId: 'artifact-removed', zoneId: 'zone-arrival' },
      { artifactId: 'artifact-gloves', zoneId: 'zone-removed' },
    ]);
    expect(evaluation.blockedCount).toBe(2);
    expect(evaluation.assessments[0].reasons).toContain('This object is no longer in the collection.');
    expect(evaluation.assessments[1].reasons).toContain('The target zone no longer exists.');
  });

  it('detects concurrent changes through the fingerprint', () => {
    const before = createSeedWorkspace();
    const plan = stageBatchPlacement(before, [{ artifactId: 'artifact-gloves', zoneId: 'zone-arrival' }], 'batch-test');
    const changed = applyPlacementCandidates(before, [{ artifactId: 'artifact-gloves', zoneId: 'zone-patterns' }]);
    const evaluation = evaluateBatchPlacement(changed, plan);
    expect(evaluation.stale).toBe(true);
    expect(evaluation.canApply).toBe(false);
  });

  it('recognizes an already-applied batch as an idempotent replay', () => {
    const applied = applyPlacementCandidates(createSeedWorkspace(), [{ artifactId: 'artifact-gloves', zoneId: 'zone-arrival' }]);
    const evaluation = evaluate([{ artifactId: 'artifact-gloves', zoneId: 'zone-arrival' }], applied);
    expect(evaluation.alreadyApplied).toBe(true);
    expect(evaluation.canApply).toBe(false);
    expect(evaluation.assessments[0].verdict).toBe('already-placed');
  });

  it('never mutates the workspace while evaluating', () => {
    const state = createSeedWorkspace();
    const snapshot = JSON.stringify(state);
    evaluate([{ artifactId: 'artifact-gloves', zoneId: 'zone-arrival' }], state);
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

describe('applyPlacementCandidates', () => {
  it('appends candidates in order and keeps zone sequences consistent', () => {
    const state = unplace(createSeedWorkspace(), 'artifact-tape');
    const next = applyPlacementCandidates(state, [
      { artifactId: 'artifact-gloves', zoneId: 'zone-arrival' },
      { artifactId: 'artifact-tape', zoneId: 'zone-arrival' },
    ]);
    expect(next.zones.find((zone) => zone.id === 'zone-arrival')!.artifactIds)
      .toEqual(['artifact-lantern', 'artifact-gloves', 'artifact-tape']);
  });

  it('honours an explicit position within the target zone', () => {
    const next = applyPlacementCandidates(createSeedWorkspace(), [
      { artifactId: 'artifact-gloves', zoneId: 'zone-arrival', index: 0 },
    ]);
    expect(next.zones.find((zone) => zone.id === 'zone-arrival')!.artifactIds)
      .toEqual(['artifact-gloves', 'artifact-lantern']);
  });

  it('moves objects between zones without duplicating them', () => {
    const next = applyPlacementCandidates(createSeedWorkspace(), [
      { artifactId: 'artifact-radio', zoneId: 'zone-arrival' },
    ]);
    expect(next.zones.find((zone) => zone.id === 'zone-patterns')!.artifactIds).toEqual(['artifact-sample-book']);
    expect(next.zones.find((zone) => zone.id === 'zone-arrival')!.artifactIds).toEqual(['artifact-lantern', 'artifact-radio']);
    expect(next.zones.flatMap((zone) => zone.artifactIds).filter((id) => id === 'artifact-radio')).toHaveLength(1);
  });

  it('is idempotent when the same candidates are applied twice', () => {
    const candidates: PlacementCandidate[] = [
      { artifactId: 'artifact-gloves', zoneId: 'zone-arrival' },
      { artifactId: 'artifact-radio', zoneId: 'zone-common', index: 1 },
    ];
    const once = applyPlacementCandidates(createSeedWorkspace(), candidates);
    const twice = applyPlacementCandidates(once, candidates);
    expect(twice.zones).toEqual(once.zones);
    expect(placementFingerprint(twice)).toBe(placementFingerprint(once));
  });

  it('throws on unknown references instead of partially applying', () => {
    expect(() => applyPlacementCandidates(createSeedWorkspace(), [
      { artifactId: 'artifact-gloves', zoneId: 'zone-arrival' },
      { artifactId: 'artifact-ghost', zoneId: 'zone-arrival' },
    ])).toThrow('not in the collection');
  });
});
