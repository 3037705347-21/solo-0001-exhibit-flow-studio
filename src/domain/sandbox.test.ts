import { describe, expect, it } from 'vitest';
import { emptyArtifactDraft } from './artifactValidation';
import { analyzeJourney } from './journeyAnalysis';
import {
  commitCapacitySandbox,
  evaluateCapacitySandbox,
  planFingerprint,
  type AddArtifactSandboxChange,
  type MoveSandboxChange,
  type SandboxChange,
  type ZoneRuleSandboxChange,
} from './sandbox';
import { createSeedWorkspace } from '../state/seed';

function addChange(id: string, draft: Partial<AddArtifactSandboxChange['draft']>, targetZoneId?: string): AddArtifactSandboxChange {
  return {
    id,
    kind: 'add',
    draft: {
      ...emptyArtifactDraft,
      accessionId: 'AF-2027-501',
      title: 'Trial Projection Plinth',
      maker: 'Studio North',
      medium: 'Wood and glass',
      summary: 'A trial plinth object used to preview how a new work reshapes the exhibition.',
      width: '12',
      height: '9',
      depth: '4',
      dwellMinutes: '2',
      ...draft,
    },
    targetZoneId,
  };
}

describe('plan fingerprint', () => {
  it('stays stable for untouched plans and changes after content edits', () => {
    const state = createSeedWorkspace();
    const preferenceOnly = { ...state, preferences: { ...state.preferences, groupSize: 3 } };
    expect(planFingerprint(preferenceOnly)).toBe(planFingerprint(state));
    const changed: typeof state = { ...state, project: { ...state.project, stage: 'ready' } };
    expect(planFingerprint(changed)).not.toBe(planFingerprint(state));
  });
});

describe('capacity sandbox evaluation', () => {
  it('combines a move, a new object, and zone rule changes into live per-zone diffs', () => {
    const state = createSeedWorkspace();
    const version = planFingerprint(state);
    const changes: SandboxChange[] = [
      { id: 'move-gloves', kind: 'move', artifactId: 'artifact-gloves', targetZoneId: 'zone-arrival' },
      addChange('add-plinth', {}, 'zone-arrival'),
      { id: 'rule-zone-arrival', kind: 'zone-rule', zoneId: 'zone-arrival', patch: { capacityMinutes: 12, maxObjects: 4 } },
    ];

    const evaluation = evaluateCapacitySandbox(state, changes);

    expect(evaluation.blocked).toBe(false);
    const arrival = evaluation.zoneDiffs.find((diff) => diff.zoneId === 'zone-arrival')!;
    expect(arrival.objectCount).toEqual({ base: 1, trial: 3 });
    expect(arrival.dwellMinutes).toEqual({ base: 4, trial: 9 });
    expect(arrival.capacityMinutes).toEqual({ base: 10, trial: 12 });
    expect(arrival.newFindings.filter((finding) => finding.type === 'error')).toHaveLength(0);
    const afterlives = evaluation.zoneDiffs.find((diff) => diff.zoneId === 'zone-after')!;
    expect(afterlives.objectCount).toEqual({ base: 2, trial: 2 });
    expect(evaluation.baseAnalysis.placedCount).toBe(7);
    expect(evaluation.trialAnalysis.placedCount).toBe(9);
    expect(afterlives.keyRemoved).toHaveLength(0);
    expect(evaluation.trialAnalysis.totalDwellMinutes).toBeGreaterThan(evaluation.baseAnalysis.totalDwellMinutes);
    expect(version).toBe(planFingerprint(state));
  });

  it('does not mutate the base plan, readiness state, or any input while evaluating', () => {
    const state = createSeedWorkspace();
    const snapshot = JSON.stringify(state);
    const changes: SandboxChange[] = [
      { id: 'move-bowl', kind: 'move', artifactId: 'artifact-bowl', targetZoneId: 'zone-arrival' },
      addChange('add-plinth', {}, 'zone-arrival'),
    ];
    const evaluation = evaluateCapacitySandbox(state, changes);
    expect(JSON.stringify(state)).toBe(snapshot);
    expect(state.zones[0].artifactIds).toEqual(['artifact-lantern']);
    // Evaluation results exist but the saved plan analysis is untouched.
    expect(analyzeJourney(state.artifacts, state.zones).placedCount).toBe(7);
    expect(evaluation.trialAnalysis.placedCount).toBe(8);
  });

  it('marks a single conflicting move (low-light object into standard light) as blocking', () => {
    const state = createSeedWorkspace();
    const changes: MoveSandboxChange[] = [
      { id: 'move-book', kind: 'move', artifactId: 'artifact-sample-book', targetZoneId: 'zone-arrival' },
    ];
    const evaluation = evaluateCapacitySandbox(state, changes);
    expect(evaluation.blocked).toBe(true);
    expect(evaluation.conflicts).toHaveLength(1);
    expect(evaluation.conflicts[0]).toMatchObject({ kind: 'light', changeId: 'move-book', zoneId: 'zone-arrival' });
  });

  it('flags operations that no longer apply as invalid changes', () => {
    const state = createSeedWorkspace();
    const changes: SandboxChange[] = [
      { id: 'move-missing', kind: 'move', artifactId: 'artifact-gone', targetZoneId: 'zone-arrival' },
      { id: 'rule-missing', kind: 'zone-rule', zoneId: 'zone-gone', patch: { maxObjects: 2 } },
    ];
    const evaluation = evaluateCapacitySandbox(state, changes);
    expect(evaluation.blocked).toBe(true);
    expect(evaluation.changeResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ changeId: 'move-missing', status: 'failed', code: 'unknown-artifact' }),
      expect.objectContaining({ changeId: 'rule-missing', status: 'failed', code: 'unknown-zone' }),
    ]));
  });

  it('rejects an invalid new object with field-level validation results', () => {
    const state = createSeedWorkspace();
    const changes: SandboxChange[] = [
      addChange('add-bad', { accessionId: 'AF-1908-014', title: '', dwellMinutes: '40' }),
    ];
    const evaluation = evaluateCapacitySandbox(state, changes);
    const result = evaluation.changeResults.find((item) => item.changeId === 'add-bad');
    expect(result?.status).toBe('failed');
    expect(['duplicate-accession', 'invalid-artifact']).toContain(result?.code);
  });
});

describe('capacity sandbox commit', () => {
  it('applies the whole valid batch atomically against the captured plan version', () => {
    const state = createSeedWorkspace();
    const version = planFingerprint(state);
    const changes: SandboxChange[] = [
      { id: 'move-gloves', kind: 'move', artifactId: 'artifact-gloves', targetZoneId: 'zone-arrival' },
      addChange('add-plinth', {}, 'zone-arrival'),
      { id: 'rule-zone-arrival', kind: 'zone-rule', zoneId: 'zone-arrival', patch: { capacityMinutes: 12, maxObjects: 4 } },
    ];

    const result = commitCapacitySandbox(state, changes, version);
    if (result.outcome !== 'applied') throw new Error(`expected applied, got ${result.outcome}`);

    const arrival = result.state.zones.find((zone) => zone.id === 'zone-arrival')!;
    expect(arrival.artifactIds).toEqual(['artifact-lantern', 'artifact-gloves', expect.any(String)]);
    expect(arrival.artifactIds).toHaveLength(3);
    expect(arrival.capacityMinutes).toBe(12);
    expect(arrival.maxObjects).toBe(4);
    const addedId = arrival.artifactIds[2];
    expect(result.state.artifacts.find((artifact) => artifact.id === addedId)?.accessionId).toBe('AF-2027-501');
    const afterlives = result.state.zones.find((zone) => zone.id === 'zone-after')!;
    expect(afterlives.artifactIds).toHaveLength(2);
    // Original state stays untouched.
    expect(state.zones[0].artifactIds).toEqual(['artifact-lantern']);
    expect(state.artifacts).toHaveLength(8);
  });

  it('stops with a version conflict when the live plan changed after the sandbox started', () => {
    const state = createSeedWorkspace();
    const staleVersion = planFingerprint(state);
    const live: typeof state = {
      ...state,
      artifacts: state.artifacts.filter((artifact) => artifact.id !== 'artifact-gloves'),
      zones: state.zones.map((zone) => ({ ...zone, artifactIds: zone.artifactIds.filter((id) => id !== 'artifact-gloves') })),
    };
    const changes: MoveSandboxChange[] = [
      { id: 'move-gloves', kind: 'move', artifactId: 'artifact-gloves', targetZoneId: 'zone-arrival' },
    ];

    const result = commitCapacitySandbox(live, changes, staleVersion);
    expect(result.outcome).toBe('version-conflict');
    if (result.outcome === 'version-conflict') {
      expect(result.expectedVersion).toBe(staleVersion);
      expect(result.currentVersion).toBe(planFingerprint(live));
    }
    // Nothing was applied.
    expect(live.artifacts).toHaveLength(7);
  });

  it('refuses to commit a batch with a single conflict and changes nothing', () => {
    const state = createSeedWorkspace();
    const version = planFingerprint(state);
    const snapshot = JSON.stringify(state);
    const changes: MoveSandboxChange[] = [
      { id: 'move-book', kind: 'move', artifactId: 'artifact-sample-book', targetZoneId: 'zone-arrival' },
    ];

    const result = commitCapacitySandbox(state, changes, version);
    expect(result.outcome).toBe('invalid-operation');
    if (result.outcome === 'invalid-operation') {
      expect(result.conflicts[0].changeId).toBe('move-book');
    }
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it('supports cancelling by simply never committing: evaluation leaves no applied trace', () => {
    const state = createSeedWorkspace();
    const snapshot = JSON.stringify(state);
    const rule: ZoneRuleSandboxChange = { id: 'rule-arrival', kind: 'zone-rule', zoneId: 'zone-arrival', patch: { capacityMinutes: 30 } };
    evaluateCapacitySandbox(state, [rule]);
    // No commit call -> plan content, version and storage-relevant state are unchanged.
    expect(JSON.stringify(state)).toBe(snapshot);
    expect(planFingerprint(state)).toBe(planFingerprint(createSeedWorkspace()));
  });
});
