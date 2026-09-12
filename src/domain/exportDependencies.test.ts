import { describe, expect, it } from 'vitest';
import { buildSnapshot, checkExportDependencies, evaluateReadiness } from './reviewRules';
import { analyzeJourney } from './journeyAnalysis';
import { checkSnapshotDependencies, noteArtifactRemoved, noteArtifactUpserted, notePlacementRemoved, recordSnapshot } from './lineage';
import { createSeedWorkspace } from '../state/seed';
import type { WorkspaceState } from './models';

function readyState(mutate?: (state: WorkspaceState) => WorkspaceState): WorkspaceState {
  let state = createSeedWorkspace();
  // Resolve all issues so readiness passes.
  state = {
    ...state,
    issues: state.issues.map((issue) => ({
      ...issue,
      status: 'resolved',
      resolvedAt: '2026-09-10T00:00:00.000Z',
    })),
  };
  // Place every key object / role is already covered in the seed; ensure all objects placed.
  const placedIds = new Set(state.zones.flatMap((zone) => zone.artifactIds));
  const unplaced = state.artifacts.filter((artifact) => !placedIds.has(artifact.id));
  const zones = [...state.zones];
  for (const artifact of unplaced) {
    zones[0] = { ...zones[0], artifactIds: [...zones[0].artifactIds, artifact.id] };
  }
  state = { ...state, zones };
  return mutate ? mutate(state) : state;
}

describe('export dependency check', () => {
  it('allows export of a current plan and embeds the dependency closure in the snapshot', () => {
    const state = readyState();
    const analysis = analyzeJourney(state.artifacts, state.zones);
    const readiness = evaluateReadiness(state, analysis);
    expect(readiness.ready).toBe(true);
    const check = checkExportDependencies(state, readiness.checkedAt);
    expect(check.deletedCount).toBe(0);
    const snapshot = buildSnapshot(state, analysis, readiness);
    expect(snapshot.lineage.dependencyCount).toBeGreaterThan(0);
    expect(snapshot.lineage.needsReviewCount).toBe(0);
    expect(snapshot.lineage.dependencies.every((dependency) => dependency.status === 'valid')).toBe(true);
  });

  it('surfaces modified-source cautions without blocking export', () => {
    const state = readyState((current) => {
      const lantern = current.artifacts.find((a) => a.id === 'artifact-lantern')!;
      const lineage = noteArtifactUpserted(
        current.lineage,
        { ...lantern, title: 'Lantern (revised label)' },
        'direct',
      ).lineage;
      return { ...current, lineage };
    });
    const analysis = analyzeJourney(state.artifacts, state.zones);
    const readiness = evaluateReadiness(state, analysis);
    const check = checkExportDependencies(state, readiness.checkedAt);
    expect(check.ready).toBe(true);
    expect(check.needsReviewCount).toBeGreaterThan(0);
    expect(check.cautions.length).toBe(1);
    const snapshot = buildSnapshot(state, analysis, readiness);
    expect(snapshot.lineage.needsReviewCount).toBeGreaterThan(0);
  });

  it('excludes a placement removed before export from the prospective closure', () => {
    const state = readyState((current) => {
      const bowl = current.artifacts.find((a) => a.id === 'artifact-bowl')!;
      // Remove a placement (source-removed); bowl is a non-key reflection object.
      const lineage = notePlacementRemoved(current.lineage, bowl);
      return {
        ...current,
        lineage,
        zones: current.zones.map((zone) => ({
          ...zone,
          artifactIds: zone.artifactIds.filter((id) => id !== 'artifact-bowl'),
        })),
      };
    });
    const analysis = analyzeJourney(state.artifacts, state.zones);
    const readiness = evaluateReadiness(state, analysis);
    const check = checkExportDependencies(state, readiness.checkedAt);
    // The removed placement is no longer in the new package, so a fresh export is clean.
    expect(check.ready).toBe(true);
    expect(check.deletedCount).toBe(0);
  });

  it('blocks an export that still references a placement traced to a deleted object', () => {
    // Inconsistent structural state is cleaned by persistence, but the graph
    // still flags any package closure that includes the orphaned placement.
    const state = readyState((current) => {
      const lineage = noteArtifactRemoved(current.lineage, 'artifact-bowl');
      return { ...current, lineage };
    });
    const analysis = analyzeJourney(state.artifacts, state.zones);
    const readiness = evaluateReadiness(state, analysis);
    const check = checkExportDependencies(state, readiness.checkedAt);
    expect(check.ready).toBe(false);
    expect(check.deletedCount).toBeGreaterThan(0);
  });

  it('flags an already published package after a source it depended on is deleted', () => {
    // 1) Publish a package while the plan is current.
    const publishedState = readyState();
    const analysis0 = analyzeJourney(publishedState.artifacts, publishedState.zones);
    const readiness0 = evaluateReadiness(publishedState, analysis0);
    const snapshot = buildSnapshot(publishedState, analysis0, readiness0);
    const snapshotId = snapshot.lineage.snapshotNodeId;
    let state: WorkspaceState = {
      ...publishedState,
      lineage: recordSnapshot(publishedState.lineage, readiness0.checkedAt, 'Published package', publishedState),
    };
    const before = checkSnapshotDependencies(state, snapshotId);
    expect(before.needsReview.length).toBe(0);

    // 2) Delete a source later and clean structural references as the reducer would.
    state = {
      ...state,
      artifacts: state.artifacts.filter((a) => a.id !== 'artifact-radio'),
      zones: state.zones.map((zone) => ({ ...zone, artifactIds: zone.artifactIds.filter((id) => id !== 'artifact-radio') })),
      lineage: noteArtifactRemoved(state.lineage, 'artifact-radio'),
    };
    const after = checkSnapshotDependencies(state, snapshotId);
    expect(after.deletedSources.length).toBeGreaterThan(0);
    expect(after.blockers.length).toBe(1);
    // The package node itself is retained (traceable), only flagged.
    expect(state.lineage.nodes.some((node) => node.id === snapshotId)).toBe(true);
  });
});
