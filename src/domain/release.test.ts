import { describe, expect, it } from 'vitest';
import { analyzeJourney } from './journeyAnalysis';
import { evaluateReadiness } from './reviewRules';
import {
  assessReleaseDrift,
  assessSnapshotDrift,
  buildReleasePackage,
  fingerprint,
  formatReleaseNumber,
  isReleasePackage,
  nextReleaseNumber,
  parseReleasePackage,
  releaseFileName,
  serializeReleasePackage,
} from './release';
import { createSeedWorkspace } from '../state/seed';
import { migrateWorkspace, validateReferences } from '../state/migrations';
import type { ReadinessResult, WorkspaceState } from './models';

function migrateRoundTrip(state: WorkspaceState): WorkspaceState {
  return migrateWorkspace(JSON.parse(JSON.stringify(state))) as WorkspaceState;
}

function readyState(): WorkspaceState {
  const seed = createSeedWorkspace();
  return { ...seed, issues: seed.issues.map((issue) => ({ ...issue, status: 'resolved' as const, resolvedAt: '2026-09-02T10:00:00.000Z' })) };
}

function readyResult(state: WorkspaceState): ReadinessResult {
  return evaluateReadiness(state, analyzeJourney(state.artifacts, state.zones), new Date('2026-09-05T12:00:00.000Z'));
}

describe('release numbering', () => {
  it('formats zero-padded stable numbers and advances the sequence', () => {
    expect(formatReleaseNumber(1)).toBe('REL-0001');
    expect(formatReleaseNumber(12)).toBe('REL-0012');
    expect(nextReleaseNumber(createSeedWorkspace())).toBe(1);
    expect(releaseFileName({ number: 3, publishedAt: '2026-09-10T08:00:00.000Z' }))
      .toBe('exhibit-flow-release-0003-2026-09-10.json');
  });
});

describe('buildReleasePackage', () => {
  it('refuses to freeze a plan that fails readiness rules', () => {
    const state = createSeedWorkspace();
    const readiness = readyResult(state);
    expect(readiness.ready).toBe(false);
    expect(() => buildReleasePackage(state, readiness)).toThrow(/readiness/);
  });

  it('freezes zones in visit order with objects, checklists, findings, and a readiness summary', () => {
    const state = readyState();
    const release = buildReleasePackage(state, readyResult(state), new Date('2026-09-05T12:00:00.000Z'));
    expect(release.kind).toBe('review-release');
    expect(release.label).toBe('REL-0001');
    expect(release.publishedAt).toBe('2026-09-05T12:00:00.000Z');
    expect(release.project.stage).toBe('ready');
    expect(release.zones.map((zone) => zone.zone.sequence)).toEqual([0, 1, 2, 3]);
    expect(release.zones[0].artifacts[0].title).toBe('Railway Signal Lantern');
    expect(release.zones[0].checklist.entries[0].accessionId).toBe('AF-1908-014');
    expect(release.issues).toHaveLength(3);
    expect(release.readiness.ready).toBe(true);
    expect(release.readiness.placedCount).toBe(7);
    expect(release.unplacedArtifacts.map((artifact) => artifact.title).sort()).toEqual(
      ['Conservator’s Gloves'],
    );
    expect(Object.keys(release.fingerprints.artifacts)).toHaveLength(8);
  });

  it('does not share object references with the workspace, so later edits cannot mutate the freeze', () => {
    const state = readyState();
    const release = buildReleasePackage(state, readyResult(state));
    state.artifacts[0].title = 'MUTATED AFTER FREEZE';
    state.issues[0].title = 'MUTATED FINDING';
    state.zones[0].name = 'MUTATED ZONE';
    expect(release.zones[0].artifacts[0].title).toBe('Railway Signal Lantern');
    expect(release.issues[0].title).not.toBe('MUTATED FINDING');
    expect(release.zones[0].zone.name).not.toBe('MUTATED ZONE');
  });
});

describe('release drift', () => {
  it('reports no drift immediately after publication', () => {
    const state = readyState();
    const release = buildReleasePackage(state, readyResult(state));
    const drift = assessReleaseDrift(release, state);
    expect(drift.drifted).toBe(false);
    expect(drift.entries).toHaveLength(0);
    expect(drift.partial).toBe(false);
  });

  it('flags edited objects with the changed fields', () => {
    const state = readyState();
    const release = buildReleasePackage(state, readyResult(state));
    const changed: WorkspaceState = {
      ...state,
      artifacts: state.artifacts.map((artifact) => artifact.id === 'artifact-lantern'
        ? { ...artifact, title: 'Signal Lantern (renamed)', dwellMinutes: 9 }
        : artifact),
    };
    const drift = assessReleaseDrift(release, changed);
    expect(drift.drifted).toBe(true);
    const entry = drift.entries.find((item) => item.id === 'artifact-lantern');
    expect(entry?.change).toBe('changed');
    expect(entry?.fieldChanges).toEqual(expect.arrayContaining(['title', 'dwell time']));
  });

  it('flags removed and added objects, zone edits, and finding status changes', () => {
    const state = readyState();
    const release = buildReleasePackage(state, readyResult(state));
    const reopenedIssue = state.issues[0];
    const changed: WorkspaceState = {
      ...state,
      artifacts: state.artifacts.filter((artifact) => artifact.id !== 'artifact-bowl'),
      zones: state.zones.map((zone) => zone.id === 'zone-arrival' ? { ...zone, name: 'Arrival renamed' } : zone),
      issues: state.issues.map((issue) => issue.id === reopenedIssue.id
        ? { ...issue, status: 'in-progress', resolvedAt: undefined }
        : issue),
    };
    const drift = assessReleaseDrift(release, changed);
    expect(drift.counts.artifact).toBe(1);
    expect(drift.counts.zone).toBe(1);
    expect(drift.counts.issue).toBe(1);
    expect(drift.entries.some((entry) => entry.id === 'artifact-bowl' && entry.change === 'removed')).toBe(true);
    expect(drift.entries.some((entry) => entry.id === reopenedIssue.id && entry.fieldChanges.includes('status'))).toBe(true);

    const withNewArtifact: WorkspaceState = {
      ...changed,
      artifacts: [...changed.artifacts, { ...changed.artifacts[0], id: 'artifact-new', accessionId: 'AF-2030-001', title: 'Brand New Object' }],
    };
    const addedDrift = assessReleaseDrift(release, withNewArtifact);
    expect(addedDrift.entries.some((entry) => entry.id === 'artifact-new' && entry.change === 'added')).toBe(true);
  });

  it('does not drift when issue records lose and regain optional links through persistence', () => {
    const state = readyState();
    const release = buildReleasePackage(state, readyResult(state));
    // Simulates the JSON persistence round trip where missing optional links
    // become explicit null (the exact regression that flagged unrelated findings).
    const persisted: WorkspaceState = {
      ...state,
      issues: state.issues.map((issue) => ({
        ...issue,
        zoneId: issue.zoneId ?? null,
        artifactId: issue.artifactId ?? null,
        resolvedAt: issue.resolvedAt ?? null,
      })) as WorkspaceState['issues'],
    };
    const reloaded = validateReferences(migrateRoundTrip(persisted));
    expect(assessReleaseDrift(release, reloaded).drifted).toBe(false);
  });

  it('placement changes drift the owning zone fingerprint', () => {
    const state = readyState();
    const release = buildReleasePackage(state, readyResult(state));
    const arrival = state.zones.find((zone) => zone.id === 'zone-arrival')!;
    const moved: WorkspaceState = {
      ...state,
      zones: state.zones.map((zone) => zone.id === arrival.id
        ? { ...zone, artifactIds: [...arrival.artifactIds, 'artifact-radio'] }
        : zone.id === 'zone-patterns'
          ? { ...zone, artifactIds: zone.artifactIds.filter((id) => id !== 'artifact-radio') }
          : zone),
    };
    const drift = assessReleaseDrift(release, moved);
    const changedZones = drift.entries.filter((entry) => entry.kind === 'zone' && entry.change === 'changed');
    expect(changedZones).toHaveLength(2);
    expect(changedZones.some((entry) => entry.fieldChanges.includes('placed objects'))).toBe(true);
  });
});

describe('release package serialization', () => {
  it('round trips a release package through JSON', () => {
    const state = readyState();
    const release = buildReleasePackage(state, readyResult(state));
    const parsed = parseReleasePackage(serializeReleasePackage(release));
    expect(parsed?.label).toBe('REL-0001');
    expect(isReleasePackage(JSON.parse(serializeReleasePackage(release)))).toBe(true);
    expect(parseReleasePackage('{not json')).toBeNull();
    expect(isReleasePackage({ kind: 'review-release', schemaVersion: 1 })).toBe(false);
  });
});

describe('fingerprints', () => {
  it('is stable regardless of object key order', () => {
    expect(fingerprint({ b: 2, a: [1, 2], c: { z: 1, y: 2 } }))
      .toBe(fingerprint({ c: { y: 2, z: 1 }, a: [1, 2], b: 2 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
});

describe('legacy snapshot drift', () => {
  it('compares only the records present in a legacy snapshot and marks the report partial', () => {
    const state = readyState();
    const release = buildReleasePackage(state, readyResult(state));
    // A legacy snapshot as exported by older builds: placed zones + unresolved issues only.
    const snapshot = {
      schemaVersion: 1 as const,
      generatedAt: release.publishedAt,
      project: release.project,
      summary: { artifactCount: 7, zoneCount: 4, visitMinutes: 46, readinessScore: 100 },
      zones: release.zones.map((item) => ({ ...item.zone, artifacts: item.artifacts })),
      unresolvedIssues: [] as never[],
    };
    const same = assessSnapshotDrift(snapshot, state);
    expect(same.drifted).toBe(false);
    expect(same.partial).toBe(true);

    const changed: WorkspaceState = {
      ...state,
      artifacts: state.artifacts.map((artifact) => artifact.id === 'artifact-lantern'
        ? { ...artifact, title: 'Lantern v2' }
        : artifact),
    };
    const drift = assessSnapshotDrift(snapshot, changed);
    expect(drift.drifted).toBe(true);
    expect(drift.partial).toBe(true);
    expect(drift.entries.some((entry) => entry.id === 'artifact-lantern')).toBe(true);
  });
});
