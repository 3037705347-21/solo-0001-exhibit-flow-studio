import { describe, expect, it } from 'vitest';
import { createPlacementRemoval } from '../domain/placementRecovery';
import type { WorkspaceState } from '../domain/models';
import { createSeedWorkspace } from './seed';
import { workspaceReducer } from './reducer';

function removeQuilt(state: WorkspaceState): WorkspaceState {
  const removal = createPlacementRemoval(state, 'artifact-quilt', 'removal-quilt', new Date('2026-09-10T10:00:00.000Z'))!;
  return workspaceReducer(state, { type: 'placement/remove', removal });
}

describe('placement removal commands', () => {
  it('removes through a recoverable transaction and restores it through the reducer', () => {
    const removed = removeQuilt(createSeedWorkspace());
    const zone = removed.zones.find((candidate) => candidate.id === 'zone-common')!;
    expect(zone.artifactIds).toEqual(['artifact-press']);
    expect(removed.removals).toHaveLength(1);
    expect(removed.removals[0].status).toBe('held');

    const restored = workspaceReducer(removed, { type: 'placement/restore', removalId: 'removal-quilt' });
    expect(restored.zones.find((candidate) => candidate.id === 'zone-common')!.artifactIds).toEqual(['artifact-press', 'artifact-quilt']);
    expect(restored.removals[0].status).toBe('restored');
    expect(restored.removals[0].restoredAt).toBeTruthy();
  });

  it('treats a repeated restore dispatch as a no-op (no duplicate placement, no second stamp)', () => {
    const removed = removeQuilt(createSeedWorkspace());
    const restored = workspaceReducer(removed, { type: 'placement/restore', removalId: 'removal-quilt' });
    const stampedAt = restored.removals[0].restoredAt;
    const again = workspaceReducer(restored, {
      type: 'placement/restore',
      removalId: 'removal-quilt',
      at: '2026-12-31T00:00:00.000Z',
    });
    const zone = again.zones.find((candidate) => candidate.id === 'zone-common')!;
    expect(zone.artifactIds.filter((id) => id === 'artifact-quilt')).toHaveLength(1);
    expect(again.removals[0].restoredAt).toBe(stampedAt);
  });

  it('keeps the original record when restore ends in review', () => {
    const removed = removeQuilt(createSeedWorkspace());
    const modified: WorkspaceState = {
      ...removed,
      artifacts: removed.artifacts.map((artifact) =>
        artifact.id === 'artifact-quilt'
          ? { ...artifact, dwellMinutes: 20, updatedAt: '2026-09-12T00:00:00.000Z' }
          : artifact,
      ),
    };
    const reviewed = workspaceReducer(modified, { type: 'placement/restore', removalId: 'removal-quilt' });
    expect(reviewed.zones.find((candidate) => candidate.id === 'zone-common')!.artifactIds).toEqual(['artifact-press']);
    expect(reviewed.removals[0].status).toBe('in-review');
    expect(reviewed.removals[0].conflictReason).toBe('object-modified');
    expect(reviewed.removals[0].createdAt).toBe(removed.removals[0].createdAt);
  });

  it('discards only the selected removal record', () => {
    const removed = removeQuilt(createSeedWorkspace());
    const discarded = workspaceReducer(removed, { type: 'placement/removal-discard', removalId: 'removal-quilt' });
    expect(discarded.removals).toEqual([]);
    expect(discarded.zones.find((candidate) => candidate.id === 'zone-common')!.artifactIds).toEqual(['artifact-press']);
  });

  it('records a snapshot publication without letting later recovery rewrite it', () => {
    const seed = createSeedWorkspace();
    const published = workspaceReducer(seed, {
      type: 'snapshot/published',
      publication: {
        generatedAt: '2026-09-01T12:00:00.000Z',
        fileName: 'exhibit-flow-snapshot-2026-09-01.json',
        readinessScore: 95,
        zoneIds: ['zone-common'],
        artifactIds: ['artifact-press', 'artifact-quilt'],
      },
    });
    expect(published.publications).toHaveLength(1);
    const removed = removeQuilt(published);
    const restored = workspaceReducer(removed, { type: 'placement/restore', removalId: 'removal-quilt' });
    expect(restored.publications).toEqual(published.publications);
  });
});
