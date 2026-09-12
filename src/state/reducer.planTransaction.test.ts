import { describe, expect, it } from 'vitest';
import { analyzeJourney } from '../domain/journeyAnalysis';
import { buildPlanSuggestions, commitPlanTransaction, preparePlanBatch, type BuildSuggestionsInput } from '../domain/planTransaction';
import { createSeedWorkspace } from './seed';
import { workspaceReducer } from './reducer';
import { migrateWorkspace } from './migrations';

const leisurelyGroup: BuildSuggestionsInput = { pace: 'leisurely', accessibilityPriority: 70, groupSize: 12 };

function previewFor(ids: string[]) {
  const state = createSeedWorkspace();
  const analysis = analyzeJourney(state.artifacts, state.zones);
  return {
    state,
    preview: preparePlanBatch(state, buildPlanSuggestions(state, analysis, leisurelyGroup), ids, leisurelyGroup),
  };
}

describe('workspace reducer planning transactions', () => {
  it('commits a valid batch and increments the revision', () => {
    const { state, preview } = previewFor(['suggest-adopt-profile', 'suggest-trim-artifact-press']);
    const next = workspaceReducer(state, { type: 'plan-transaction/commit', preview, transactionId: 'plan-1' });
    expect(next.revision).toBe(state.revision + 1);
    expect(next.preferences.pace).toBe('leisurely');
    expect(next.artifacts.find((artifact) => artifact.id === 'artifact-press')?.dwellMinutes).toBe(5);
  });

  it('writes nothing when the batch revision is stale', () => {
    const { state, preview } = previewFor(['suggest-adopt-profile']);
    const drifted = { ...state, revision: state.revision + 4 };
    const next = workspaceReducer(drifted, { type: 'plan-transaction/commit', preview, transactionId: 'plan-2' });
    expect(next).toBe(drifted);
    expect(next.preferences.pace).toBe('balanced');
  });

  it('writes nothing when an object referenced by the batch is gone', () => {
    const { state, preview } = previewFor(['suggest-trim-artifact-press']);
    const drifted = {
      ...state,
      revision: state.revision + 1,
      artifacts: state.artifacts.filter((artifact) => artifact.id !== 'artifact-press'),
    };
    const next = workspaceReducer(drifted, { type: 'plan-transaction/commit', preview, transactionId: 'plan-3' });
    expect(next).toBe(drifted);
    expect(next.artifacts.length).toBe(drifted.artifacts.length);
  });

  it('reverts a committed move back to the original zone', () => {
    const { state, preview } = previewFor(['suggest-move-artifact-quilt-zone-patterns', 'suggest-trim-artifact-quilt']);
    const { state: committed, transaction } = commitPlanTransaction(state, preview, { id: 'plan-4' });
    const inPatterns = committed.zones.find((zone) => zone.id === 'zone-patterns')!;
    expect(inPatterns.artifactIds).toContain('artifact-quilt');
    const reverted = workspaceReducer(committed, { type: 'plan-transaction/revert', transaction });
    expect(reverted.zones.find((zone) => zone.id === 'zone-common')!.artifactIds).toContain('artifact-quilt');
    expect(reverted.zones.find((zone) => zone.id === 'zone-patterns')!.artifactIds).not.toContain('artifact-quilt');
    // The dwell trim captured in the transaction is also restored.
    expect(reverted.artifacts.find((artifact) => artifact.id === 'artifact-quilt')!.dwellMinutes).toBe(8);
  });

  it('adopts external workspace sync without bumping the revision again', () => {
    const state = createSeedWorkspace();
    const external = { ...state, revision: 9, preferences: { ...state.preferences, pace: 'focused' as const } };
    const next = workspaceReducer(state, { type: 'workspace/sync-external', state: external });
    expect(next.revision).toBe(9);
    expect(next.preferences.pace).toBe('focused');
  });

  it('defaults missing revision to 1 when migrating legacy storage', () => {
    const legacy = {
      project: createSeedWorkspace().project,
      artifacts: [],
      zones: [],
      issues: [],
      preferences: createSeedWorkspace().preferences,
    };
    const migrated = migrateWorkspace(legacy)!;
    expect(migrated.revision).toBe(1);
    const withRevision = migrateWorkspace({ ...legacy, revision: 27 })!;
    expect(withRevision.revision).toBe(27);
  });
});
