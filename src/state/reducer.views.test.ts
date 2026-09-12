import { describe, expect, it } from 'vitest';
import type { CollectionFilter } from '../domain/models';
import { createCollectionView } from '../domain/collectionViews';
import { workspaceReducer } from './reducer';
import { createSeedWorkspace } from './seed';

const reflectionRules: CollectionFilter = { query: '', roles: ['reflection'], sensitivities: [], keyOnly: false };

function stateWith(views = createSeedWorkspace().collectionViews) {
  return { ...createSeedWorkspace(), collectionViews: views };
}

describe('workspace reducer collection view actions', () => {
  it('saves live and frozen views without touching project readiness or artifacts', () => {
    const initial = stateWith();
    const live = createCollectionView({ id: 'view-live', name: 'Live reflections', kind: 'live', rules: reflectionRules, artifacts: initial.artifacts, at: '2026-09-10T10:00:00.000Z' });
    const afterLive = workspaceReducer(initial, { type: 'collectionView/save', view: live });
    expect(afterLive.collectionViews).toHaveLength(1);
    expect(afterLive.artifacts).toBe(initial.artifacts);
    expect(afterLive.project.stage).toBe(initial.project.stage);

    const frozen = createCollectionView({ id: 'view-frozen', name: 'Issued reflections', kind: 'frozen', rules: reflectionRules, artifacts: initial.artifacts, at: '2026-09-10T11:00:00.000Z' });
    const afterFrozen = workspaceReducer(afterLive, { type: 'collectionView/save', view: frozen });
    expect(afterFrozen.collectionViews.map((view) => view.kind)).toEqual(['live', 'frozen']);
    expect(afterFrozen.collectionViews[1].frozenMembers).toHaveLength(3);
  });

  it('appends a new rule version when a live view is revised', () => {
    const initial = stateWith([
      createCollectionView({ id: 'view-live', name: 'Live reflections', kind: 'live', rules: reflectionRules, artifacts: createSeedWorkspace().artifacts, at: '2026-09-10T10:00:00.000Z' }),
    ]);
    const revised = workspaceReducer(initial, {
      type: 'collectionView/revise',
      viewId: 'view-live',
      rules: { query: '', roles: ['threshold'], sensitivities: [], keyOnly: false },
      at: '2026-09-11T10:00:00.000Z',
    });
    expect(revised.collectionViews[0].ruleVersions).toHaveLength(2);
    expect(revised.collectionViews[0].ruleVersions[1].memberIds).toEqual(['artifact-lantern']);
  });

  it('refuses to revise a frozen list', () => {
    const frozen = createCollectionView({ id: 'view-frozen', name: 'Issued reflections', kind: 'frozen', rules: reflectionRules, artifacts: createSeedWorkspace().artifacts, at: '2026-09-10T10:00:00.000Z' });
    const initial = stateWith([frozen]);
    expect(() => workspaceReducer(initial, {
      type: 'collectionView/revise',
      viewId: 'view-frozen',
      rules: reflectionRules,
      at: '2026-09-11T10:00:00.000Z',
    })).toThrow(/Frozen lists cannot be revised/);
  });

  it('removes only the targeted view by id', () => {
    const live = createCollectionView({ id: 'view-live', name: 'Live reflections', kind: 'live', rules: reflectionRules, artifacts: createSeedWorkspace().artifacts, at: '2026-09-10T10:00:00.000Z' });
    const frozen = createCollectionView({ id: 'view-frozen', name: 'Issued reflections', kind: 'frozen', rules: reflectionRules, artifacts: createSeedWorkspace().artifacts, at: '2026-09-10T11:00:00.000Z' });
    const initial = stateWith([live, frozen]);
    const after = workspaceReducer(initial, { type: 'collectionView/remove', viewId: 'view-live' });
    expect(after.collectionViews.map((view) => view.id)).toEqual(['view-frozen']);
    expect(after.collectionViews[0].frozenMembers).toHaveLength(3);
  });

  it('keeps frozen member snapshots intact when an artifact is deleted', () => {
    const frozen = createCollectionView({ id: 'view-frozen', name: 'Issued reflections', kind: 'frozen', rules: reflectionRules, artifacts: createSeedWorkspace().artifacts, at: '2026-09-10T11:00:00.000Z' });
    const initial = stateWith([frozen]);
    const after = workspaceReducer(initial, { type: 'artifact/remove', artifactId: 'artifact-tape' });
    const view = after.collectionViews[0];
    expect(view.frozenMembers?.map((member) => member.artifactId)).toContain('artifact-tape');
    expect(after.artifacts.some((artifact) => artifact.id === 'artifact-tape')).toBe(false);
  });
});
