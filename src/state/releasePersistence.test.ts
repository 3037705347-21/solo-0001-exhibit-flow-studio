import { describe, expect, it } from 'vitest';
import { analyzeJourney } from '../domain/journeyAnalysis';
import { buildReleasePackage } from '../domain/release';
import { evaluateReadiness } from '../domain/reviewRules';
import type { WorkspaceState } from '../domain/models';
import { workspaceReducer } from './reducer';
import { createSeedWorkspace } from './seed';
import { migrateWorkspace, validateReferences } from './migrations';

function readyWorkspace(): WorkspaceState {
  const seed = createSeedWorkspace();
  return { ...seed, issues: seed.issues.map((issue) => ({ ...issue, status: 'resolved' as const })) };
}

describe('release reducer', () => {
  it('appends an immutable release and advances the sequence', () => {
    const state = readyWorkspace();
    const readiness = evaluateReadiness(state, analyzeJourney(state.artifacts, state.zones), new Date('2026-09-05T12:00:00.000Z'));
    const release = buildReleasePackage(state, readiness, new Date('2026-09-05T12:00:00.000Z'), 1);

    const published = workspaceReducer(state, { type: 'release/publish', release });
    expect(published.releases).toHaveLength(1);
    expect(published.releaseSequence).toBe(1);
    expect(published.releases[0].label).toBe('REL-0001');
    // Publishing atomically records the freeze and marks the project ready at that instant.
    expect(published.project.stage).toBe('ready');
    expect(published.project.lastReadinessCheck).toBe('2026-09-05T12:00:00.000Z');

    const second = buildReleasePackage(published, evaluateReadiness(published, analyzeJourney(published.artifacts, published.zones)), new Date('2026-09-06T12:00:00.000Z'), 2);
    const publishedAgain = workspaceReducer(published, { type: 'release/publish', release: second });
    expect(publishedAgain.releases).toHaveLength(2);
    expect(publishedAgain.releases[0]).toBe(published.releases[0]);
  });

  it('keeps published releases when the workspace later regresses through edits', () => {
    const state = readyWorkspace();
    const release = buildReleasePackage(state, evaluateReadiness(state, analyzeJourney(state.artifacts, state.zones)));
    const published = workspaceReducer(state, { type: 'release/publish', release });
    const edited = workspaceReducer(published, {
      type: 'issue/add',
      issue: { ...state.issues[0], id: 'issue-new', title: 'New blocker', status: 'open', severity: 'critical' },
    });
    expect(edited.releases).toHaveLength(1);
    expect(edited.releases[0].label).toBe('REL-0001');
  });
});

describe('workspace migration for releases', () => {
  it('adds empty release storage to legacy workspaces saved before the feature', () => {
    const seed = createSeedWorkspace();
    const legacy = {
      version: 1,
      project: seed.project,
      artifacts: seed.artifacts,
      zones: seed.zones,
      issues: seed.issues,
      preferences: seed.preferences,
    };
    const migrated = migrateWorkspace(legacy);
    expect(migrated?.releases).toEqual([]);
    expect(migrated?.releaseSequence).toBe(0);
  });

  it('drops malformed release records but recovers the sequence from survivors', () => {
    const seed = createSeedWorkspace();
    const ready = readyWorkspace();
    const release = buildReleasePackage(ready, evaluateReadiness(ready, analyzeJourney(ready.artifacts, ready.zones)));
    const withReleases = {
      version: 1,
      project: seed.project,
      artifacts: seed.artifacts,
      zones: seed.zones,
      issues: seed.issues,
      preferences: seed.preferences,
      releases: [{ kind: 'review-release' }, release],
    };
    const migrated = migrateWorkspace(withReleases);
    expect(migrated?.releases).toHaveLength(1);
    expect(migrated?.releaseSequence).toBe(1);
  });

  it('strips null optional issue links produced by JSON round trips so fingerprints stay stable', () => {
    const seed = createSeedWorkspace();
    const persisted = {
      ...seed,
      releases: [],
      releaseSequence: 0,
      issues: seed.issues.map((issue) => ({ ...issue, artifactId: null, zoneId: issue.zoneId ?? null, resolvedAt: issue.resolvedAt ?? null })),
    };
    const migrated = validateReferences(migrateWorkspace(persisted)!);
    for (const issue of migrated.issues) {
      expect(Object.prototype.hasOwnProperty.call(issue, 'artifactId')).toBe(false);
      if (issue.zoneId === undefined) expect(Object.prototype.hasOwnProperty.call(issue, 'zoneId')).toBe(false);
      if (issue.resolvedAt === undefined) expect(Object.prototype.hasOwnProperty.call(issue, 'resolvedAt')).toBe(false);
    }
  });
});
