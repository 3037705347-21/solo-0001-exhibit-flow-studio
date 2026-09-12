import { describe, expect, it } from 'vitest';
import { impactBaseVersion, previewArtifactImpact, summarizeImpact } from './impactPreview';
import type { Artifact, WorkspaceState } from './models';
import { createSeedWorkspace } from '../state/seed';

function patchedArtifact(state: WorkspaceState, id: string, patch: Partial<Artifact>): Artifact {
  const artifact = state.artifacts.find((candidate) => candidate.id === id);
  if (!artifact) throw new Error(`Unknown artifact ${id}`);
  return { ...artifact, ...patch };
}

describe('artifact impact preview', () => {
  it('reports no impact when only descriptive fields change', () => {
    const state = createSeedWorkspace();
    const next = patchedArtifact(state, 'artifact-lantern', {
      title: 'Renamed Signal Lantern',
      summary: 'A rewritten summary that still describes the lantern and its working history.',
    });
    const preview = previewArtifactImpact(state, next);
    expect(preview.hasImpact).toBe(false);
    expect(preview.fieldChanges).toHaveLength(0);
    expect(preview.affectedZones).toHaveLength(0);
    expect(preview.journeyFindings).toHaveLength(0);
    expect(preview.addedBlockers).toHaveLength(0);
    expect(preview.readinessAfter.score).toBe(preview.readinessBefore.score);
    expect(summarizeImpact(preview)).toBe('No journey impact');
  });

  it('reports every affected zone when the object is referenced by multiple zones', () => {
    const state = createSeedWorkspace();
    const dualPlacement: WorkspaceState = {
      ...state,
      zones: state.zones.map((zone) => zone.id === 'zone-after'
        ? { ...zone, artifactIds: [...zone.artifactIds, 'artifact-lantern'] }
        : zone),
    };
    const next = patchedArtifact(dualPlacement, 'artifact-lantern', { dwellMinutes: 12 });
    const preview = previewArtifactImpact(dualPlacement, next);

    expect(preview.affectedZones.map((zone) => zone.zoneId).sort()).toEqual(['zone-after', 'zone-arrival']);

    const arrival = preview.affectedZones.find((zone) => zone.zoneId === 'zone-arrival');
    expect(arrival?.dwellBefore).toBe(4);
    expect(arrival?.dwellAfter).toBe(12);
    expect(arrival?.addedFindings.some((finding) => finding.id === 'capacity-zone-arrival' && finding.type === 'error')).toBe(true);

    const after = preview.affectedZones.find((zone) => zone.zoneId === 'zone-after');
    expect(after?.dwellBefore).toBe(14);
    expect(after?.dwellAfter).toBe(22);
    expect(after?.addedFindings.some((finding) => finding.id === 'capacity-zone-after' && finding.type === 'error')).toBe(true);
    expect(after?.resolvedFindings.some((finding) => finding.id === 'capacity-warning-zone-after')).toBe(true);

    expect(preview.addedBlockers).toHaveLength(2);
    expect(preview.readinessAfter.score).toBeLessThan(preview.readinessBefore.score);
    expect(preview.fieldChanges.map((change) => change.key)).toEqual(['dwellMinutes']);
    expect(summarizeImpact(preview)).toContain('Dwell time 4 min → 12 min');
  });

  it('flags a readiness blocker when a key object is not part of the journey', () => {
    const state = createSeedWorkspace();
    const next = patchedArtifact(state, 'artifact-gloves', { isKeyObject: true });
    const preview = previewArtifactImpact(state, next);
    expect(preview.journeyFindings.some((delta) => delta.kind === 'added' && delta.finding.id === 'unplaced-key-artifact-gloves')).toBe(true);
    expect(preview.readinessAfter.ready).toBe(false);
    expect(preview.readinessAfter.blockers.length).toBeGreaterThan(preview.readinessBefore.blockers.length);
  });

  it('versions the preview against the object and the plan', () => {
    const state = createSeedWorkspace();
    const preview = previewArtifactImpact(state, patchedArtifact(state, 'artifact-lantern', { dwellMinutes: 9 }));
    expect(preview.baseVersion).toBe(impactBaseVersion(state));

    const planChanged: WorkspaceState = {
      ...state,
      zones: state.zones.map((zone) => zone.id === 'zone-arrival' ? { ...zone, capacityMinutes: 30 } : zone),
    };
    expect(impactBaseVersion(planChanged)).not.toBe(preview.baseVersion);

    const objectChanged: WorkspaceState = {
      ...state,
      artifacts: state.artifacts.map((artifact) => artifact.id === 'artifact-lantern' ? { ...artifact, dwellMinutes: 6 } : artifact),
    };
    expect(impactBaseVersion(objectChanged)).not.toBe(preview.baseVersion);
  });
});
