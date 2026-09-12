import { describe, expect, it } from 'vitest';
import { placementFingerprint, stageBatchPlacement } from '../domain/batchPlacement';
import { getUnplacedArtifacts } from '../domain/journeyAnalysis';
import { createSeedWorkspace } from './seed';
import { workspaceReducer } from './reducer';
import type { WorkspaceAction } from './actions';

function batchAction(candidates: Array<{ artifactId: string; zoneId: string; index?: number }>, baseFingerprint?: string): WorkspaceAction {
  const state = createSeedWorkspace();
  return {
    type: 'placement/batch',
    transactionId: 'batch-test',
    baseFingerprint: baseFingerprint ?? placementFingerprint(state),
    candidates,
  };
}

describe('placement/batch', () => {
  it('applies the whole batch atomically and keeps zone order and queue consistent', () => {
    const state = createSeedWorkspace();
    const action = batchAction([
      { artifactId: 'artifact-gloves', zoneId: 'zone-arrival' },
      { artifactId: 'artifact-radio', zoneId: 'zone-common', index: 0 },
    ]);
    const next = workspaceReducer(state, action);
    expect(next.zones.find((zone) => zone.id === 'zone-arrival')!.artifactIds).toEqual(['artifact-lantern', 'artifact-gloves']);
    expect(next.zones.find((zone) => zone.id === 'zone-common')!.artifactIds).toEqual(['artifact-radio', 'artifact-press', 'artifact-quilt']);
    expect(next.zones.find((zone) => zone.id === 'zone-patterns')!.artifactIds).toEqual(['artifact-sample-book']);
    expect(getUnplacedArtifacts(next.artifacts, next.zones)).toEqual([]);
    expect(next.lastSavedAt).not.toBe(state.lastSavedAt);
  });

  it('is idempotent: replaying the same batch returns the state unchanged', () => {
    const state = createSeedWorkspace();
    const action = batchAction([{ artifactId: 'artifact-gloves', zoneId: 'zone-arrival' }]);
    const once = workspaceReducer(state, action);
    const twice = workspaceReducer(once, action);
    expect(twice).toBe(once);
  });

  it('treats a candidate already in its target zone as a no-op', () => {
    const state = createSeedWorkspace();
    const next = workspaceReducer(state, batchAction([{ artifactId: 'artifact-lantern', zoneId: 'zone-arrival' }]));
    expect(next).toBe(state);
  });

  it('rejects the batch when the workspace changed since it was staged', () => {
    const state = createSeedWorkspace();
    const staged = stageBatchPlacement(state, [{ artifactId: 'artifact-gloves', zoneId: 'zone-arrival' }], 'batch-test');
    const changed = workspaceReducer(state, { type: 'placement/assign', artifactId: 'artifact-gloves', zoneId: 'zone-patterns' });
    expect(() => workspaceReducer(changed, {
      type: 'placement/batch',
      transactionId: staged.transactionId,
      baseFingerprint: staged.baseFingerprint,
      candidates: staged.candidates,
    })).toThrow('changed since this batch was prepared');
    expect(getUnplacedArtifacts(changed.artifacts, changed.zones)).toEqual([]);
  });

  it('applies nothing when any candidate is invalid', () => {
    const state = createSeedWorkspace();
    const action = batchAction([
      { artifactId: 'artifact-gloves', zoneId: 'zone-arrival' },
      { artifactId: 'artifact-ghost', zoneId: 'zone-arrival' },
    ]);
    expect(() => workspaceReducer(state, action)).toThrow('not in the collection');
    expect(getUnplacedArtifacts(state.artifacts, state.zones).map((artifact) => artifact.id)).toEqual(['artifact-gloves']);
  });

  it('regresses a ready project back to review', () => {
    const state = { ...createSeedWorkspace(), project: { ...createSeedWorkspace().project, stage: 'ready' as const } };
    const next = workspaceReducer(state, {
      type: 'placement/batch',
      transactionId: 'batch-test',
      baseFingerprint: placementFingerprint(state),
      candidates: [{ artifactId: 'artifact-gloves', zoneId: 'zone-arrival' }],
    });
    expect(next.project.stage).toBe('review');
  });
});
