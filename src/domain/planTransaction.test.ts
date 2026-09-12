import { describe, expect, it } from 'vitest';
import { analyzeJourney } from './journeyAnalysis';
import { createSeedWorkspace } from '../state/seed';
import {
  PlanTransactionError,
  buildPlanSuggestions,
  commitPlanTransaction,
  invertPlanChanges,
  preparePlanBatch,
  revertPlanTransaction,
  validatePlanChanges,
  validateRevertFacts,
  type BuildSuggestionsInput,
  type PlanBatchPreview,
} from './planTransaction';
import type { WorkspaceState } from './models';

const leisurelyGroup: BuildSuggestionsInput = { pace: 'leisurely', accessibilityPriority: 70, groupSize: 12 };

function withSuggestions(state: WorkspaceState, input = leisurelyGroup) {
  const analysis = analyzeJourney(state.artifacts, state.zones);
  return { analysis, suggestions: buildPlanSuggestions(state, analysis, input) };
}

function batch(state: WorkspaceState, ids: string[], input = leisurelyGroup): PlanBatchPreview {
  const { suggestions } = withSuggestions(state, input);
  return preparePlanBatch(state, suggestions, ids, input);
}

describe('plan suggestion generation', () => {
  it('offers the visitor profile only when it differs from saved preferences', () => {
    const state = createSeedWorkspace();
    const same = withSuggestions(state, { pace: 'balanced', accessibilityPriority: 70, groupSize: 6 });
    expect(same.suggestions.some((s) => s.id === 'suggest-adopt-profile')).toBe(false);
    const changed = withSuggestions(state, leisurelyGroup);
    expect(changed.suggestions.some((s) => s.id === 'suggest-adopt-profile')).toBe(true);
  });

  it('generates pressure-relief moves for pressured zones', () => {
    const state = createSeedWorkspace();
    const { suggestions } = withSuggestions(state);
    const moves = suggestions.filter((s) => s.changes.some((c) => c.kind === 'artifact-move'));
    expect(moves.length).toBeGreaterThan(0);
    const pressMove = moves.find((s) => s.id.startsWith('suggest-move-artifact-press'));
    expect(pressMove).toBeDefined();
    expect(pressMove!.changes[0]).toMatchObject({ kind: 'artifact-move', fromZoneId: 'zone-common' });
    // Two objects leaving the same pressure zone are routed to distinct targets.
    const quiltMove = suggestions.find((s) => s.id === 'suggest-move-artifact-quilt-zone-patterns');
    expect(quiltMove).toBeDefined();
    const destinations = new Set(moves.map((s) => (s.changes[0] as { toZoneId: string }).toZoneId));
    expect(destinations.size).toBe(moves.length);
  });

  it('emits trim suggestions that a capacity-tight move depends on', () => {
    const state = createSeedWorkspace();
    const { suggestions } = withSuggestions(state);
    const quiltMove = suggestions.find((s) => s.id === 'suggest-move-artifact-quilt-zone-patterns');
    expect(quiltMove).toBeDefined();
    expect(quiltMove!.requires).toContain('suggest-trim-artifact-quilt');
    const trim = suggestions.find((s) => s.id === 'suggest-trim-artifact-quilt');
    expect(trim?.changes[0]).toMatchObject({ kind: 'artifact-dwell', artifactId: 'artifact-quilt', dwellMinutes: 6 });
  });
});

describe('plan batch preparation', () => {
  it('applies a single suggestion cleanly', () => {
    const state = createSeedWorkspace();
    const preview = batch(state, ['suggest-adopt-profile']);
    expect(preview.canCommit).toBe(true);
    expect(preview.factDeltas.map((d) => d.key)).toEqual(['preferences']);
    expect(preview.factDeltas[0].after).toContain('Leisurely');
  });

  it('flags a missing dependency as a blocking combination issue', () => {
    const state = createSeedWorkspace();
    const preview = batch(state, ['suggest-move-artifact-quilt-zone-patterns']);
    expect(preview.canCommit).toBe(false);
    expect(preview.issues.some((i) => i.code === 'missing-dependency')).toBe(true);
    const satisfied = batch(state, ['suggest-move-artifact-quilt-zone-patterns', 'suggest-trim-artifact-quilt']);
    expect(satisfied.issues.some((i) => i.code === 'missing-dependency')).toBe(false);
  });

  it('flags fact conflicts when two suggestions write the same plan fact', () => {
    const state = createSeedWorkspace();
    const { suggestions } = withSuggestions(state);
    const crafted = [...suggestions];
    // Duplicate the profile suggestion with conflicting preference values.
    crafted.push({
      id: 'suggest-adopt-profile-2',
      title: 'Other profile',
      detail: '',
      category: 'visit-preferences',
      changes: [{ kind: 'preferences', preferences: { pace: 'focused', accessibilityPriority: 10, groupSize: 2 } }],
      requires: [],
    });
    const preview = preparePlanBatch(state, crafted, ['suggest-adopt-profile', 'suggest-adopt-profile-2'], leisurelyGroup);
    expect(preview.canCommit).toBe(false);
    expect(preview.issues.some((i) => i.code === 'fact-conflict')).toBe(true);
  });

  it('rejects batches that push a zone beyond capacity', () => {
    const state = createSeedWorkspace();
    // Hand-build two moves that individually fit nowhere together: press (7)
    // and the radio (5) both into Arrival, which has only 10 free minutes.
    const crafted: Parameters<typeof preparePlanBatch>[1] = [
      {
        id: 'crafted-press-to-arrival',
        title: 'Move press to arrival',
        detail: '',
        category: 'zone-pressure',
        changes: [{ kind: 'artifact-move', artifactId: 'artifact-press', fromZoneId: 'zone-common', toZoneId: 'zone-arrival', index: 1 }],
        requires: [],
      },
      {
        id: 'crafted-radio-to-arrival',
        title: 'Move radio to arrival',
        detail: '',
        category: 'zone-pressure',
        changes: [{ kind: 'artifact-move', artifactId: 'artifact-radio', fromZoneId: 'zone-patterns', toZoneId: 'zone-arrival', index: 2 }],
        requires: [],
      },
    ];
    const preview = preparePlanBatch(state, crafted, ['crafted-press-to-arrival', 'crafted-radio-to-arrival'], leisurelyGroup);
    expect(preview.canCommit).toBe(false);
    expect(preview.issues.some((i) => i.code === 'capacity-exceeded')).toBe(true);
  });

  it('reports predicted outcome metrics against the scenario baseline', () => {
    const state = createSeedWorkspace();
    const preview = batch(state, ['suggest-trim-artifact-quilt', 'suggest-trim-artifact-press']);
    expect(preview.canCommit).toBe(true);
    expect(preview.prediction.deltas.durationMinutes).toBeLessThan(0);
  });
});

describe('plan transaction commit and revert', () => {
  it('applies the whole batch atomically and bumps the revision once', () => {
    const state = createSeedWorkspace();
    const before = state.revision;
    const preview = batch(state, ['suggest-adopt-profile', 'suggest-trim-artifact-press']);
    const { state: next, transaction } = commitPlanTransaction(state, preview, { id: 'plan-test-1' });
    expect(next.revision).toBe(before + 1);
    expect(next.preferences.pace).toBe('leisurely');
    expect(next.artifacts.find((a) => a.id === 'artifact-press')?.dwellMinutes).toBe(5);
    expect(transaction.changes.length).toBe(2);
    expect(transaction.suggestionIds).toEqual(['suggest-adopt-profile', 'suggest-trim-artifact-press']);
  });

  it('rejects the whole commit on a version conflict without writing anything', () => {
    const state = createSeedWorkspace();
    const { suggestions } = withSuggestions(state);
    const stale = preparePlanBatch(state, suggestions, ['suggest-adopt-profile'], leisurelyGroup);
    const drifted: WorkspaceState = {
      ...state,
      revision: state.revision + 5,
      preferences: { ...state.preferences, groupSize: 9 },
    };
    expect(() => commitPlanTransaction(drifted, stale, { id: 'plan-stale' })).toThrow(PlanTransactionError);
    try {
      commitPlanTransaction(drifted, stale, { id: 'plan-stale' });
    } catch (error) {
      expect(error).toBeInstanceOf(PlanTransactionError);
      expect((error as PlanTransactionError).issues[0].code).toBe('version-conflict');
    }
    expect(drifted.preferences.pace).toBe('balanced');
  });

  it('rejects commits referencing an object that was removed externally', () => {
    const state = createSeedWorkspace();
    const { suggestions } = withSuggestions(state);
    const preview = preparePlanBatch(state, suggestions, ['suggest-trim-artifact-press'], leisurelyGroup);
    const drifted: WorkspaceState = {
      ...state,
      revision: state.revision + 1,
      artifacts: state.artifacts.filter((artifact) => artifact.id !== 'artifact-press'),
    };
    expect(() => commitPlanTransaction(drifted, preview, { id: 'plan-missing' })).toThrow(PlanTransactionError);
    try {
      commitPlanTransaction(drifted, preview, { id: 'plan-missing' });
    } catch (error) {
      expect((error as PlanTransactionError).issues.some((i) => i.code === 'invalid-object')).toBe(true);
    }
  });

  it('reverts a committed transaction back to the original facts', () => {
    const state = createSeedWorkspace();
    const preview = batch(state, ['suggest-adopt-profile', 'suggest-trim-artifact-press']);
    const { state: committed, transaction } = commitPlanTransaction(state, preview, { id: 'plan-revert' });
    expect(committed.preferences.pace).toBe('leisurely');
    const reverted = revertPlanTransaction(committed, transaction);
    expect(reverted.preferences.pace).toBe('balanced');
    expect(reverted.preferences.groupSize).toBe(6);
    expect(reverted.artifacts.find((a) => a.id === 'artifact-press')?.dwellMinutes).toBe(7);
    expect(reverted.revision).toBe(committed.revision + 1);
  });

  it('refuses to revert when the moved object was moved again afterwards', () => {
    const state = createSeedWorkspace();
    const preview = batch(state, ['suggest-move-artifact-quilt-zone-patterns', 'suggest-trim-artifact-quilt']);
    const { state: committed, transaction } = commitPlanTransaction(state, preview, { id: 'plan-move' });
    // Simulate the object being moved back to common by another edit.
    const tampered: WorkspaceState = {
      ...committed,
      revision: committed.revision + 1,
      zones: committed.zones.map((zone) => {
        if (zone.id === 'zone-patterns') return { ...zone, artifactIds: zone.artifactIds.filter((id) => id !== 'artifact-quilt') };
        if (zone.id === 'zone-common') return { ...zone, artifactIds: [...zone.artifactIds, 'artifact-quilt'] };
        return zone;
      }),
    };
    expect(() => revertPlanTransaction(tampered, transaction)).toThrow(PlanTransactionError);
  });

  it('refuses to undo when the same fact was edited again after commit', () => {
    const state = createSeedWorkspace();
    const preview = batch(state, ['suggest-trim-artifact-press']);
    const { state: committed, transaction } = commitPlanTransaction(state, preview, { id: 'plan-retrim' });
    expect(committed.artifacts.find((a) => a.id === 'artifact-press')?.dwellMinutes).toBe(5);
    // A later command changed the same stay again.
    const editedAgain: WorkspaceState = {
      ...committed,
      revision: committed.revision + 1,
      artifacts: committed.artifacts.map((artifact) =>
        artifact.id === 'artifact-press' ? { ...artifact, dwellMinutes: 3 } : artifact,
      ),
    };
    const factIssues = validateRevertFacts(editedAgain, transaction.changes);
    expect(factIssues.some((issue) => issue.code === 'fact-mismatch')).toBe(true);
    expect(() => revertPlanTransaction(editedAgain, transaction)).toThrow(PlanTransactionError);
  });

  it('still undoes when an unrelated fact changed after commit', () => {
    const state = createSeedWorkspace();
    const preview = batch(state, ['suggest-trim-artifact-press']);
    const { state: committed, transaction } = commitPlanTransaction(state, preview, { id: 'plan-unrelated' });
    const unrelatedEdit: WorkspaceState = {
      ...committed,
      revision: committed.revision + 1,
      artifacts: committed.artifacts.map((artifact) =>
        artifact.id === 'artifact-radio' ? { ...artifact, dwellMinutes: 9 } : artifact,
      ),
    };
    const reverted = revertPlanTransaction(unrelatedEdit, transaction);
    expect(reverted.artifacts.find((a) => a.id === 'artifact-press')?.dwellMinutes).toBe(7);
    expect(reverted.artifacts.find((a) => a.id === 'artifact-radio')?.dwellMinutes).toBe(9);
  });

  it('inverts moves in an order that restores original placements', () => {
    const state = createSeedWorkspace();
    const preview = batch(state, ['suggest-move-artifact-quilt-zone-patterns', 'suggest-trim-artifact-quilt']);
    commitPlanTransaction(state, preview, { id: 'plan-move-2' });
    const inverse = invertPlanChanges(preview.suggestions.flatMap((s) => s.changes), state);
    const inverseMove = inverse.find((change) => change.kind === 'artifact-move');
    expect(inverseMove).toMatchObject({ kind: 'artifact-move', fromZoneId: 'zone-patterns', toZoneId: 'zone-common' });
  });

  it('exposes no blocking issues for a capacity-safe move on the seed plan', () => {
    const state = createSeedWorkspace();
    const preview = batch(state, ['suggest-move-artifact-quilt-zone-patterns', 'suggest-trim-artifact-quilt']);
    expect(preview.canCommit).toBe(true);
    expect(validatePlanChanges(state, preview.suggestions.flatMap((s) => s.changes)).filter((i) => i.blocking)).toHaveLength(0);
  });
});
