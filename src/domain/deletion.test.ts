import { describe, expect, it } from 'vitest';
import { createSeedWorkspace } from '../state/seed';
import {
  analyzeRestore,
  applyDeletion,
  AUDIT_HORIZON_MS,
  commitRestore,
  getDeletionStatus,
  planArtifactDelete,
  planIssueDelete,
  planZoneDelete,
  pruneDeletionHistory,
  RESTORE_WINDOW_MS,
} from './deletion';
import type { Artifact, PublishedPackage, ReviewIssue, WorkspaceState, Zone } from './models';
import { createId } from './ids';

const NOW = new Date('2026-09-10T12:00:00.000Z');

function seed(): WorkspaceState {
  const state = createSeedWorkspace();
  return { ...state, publishedPackages: [], deletionRecords: [], restoreReports: [] };
}

function withPublishedPackage(state: WorkspaceState, pkg: Partial<PublishedPackage>): WorkspaceState {
  const full: PublishedPackage = {
    id: createId('package'),
    kind: 'snapshot',
    fileName: 'exhibit-flow-snapshot-2026-09-01.json',
    publishedAt: '2026-09-01T10:00:00.000Z',
    projectTitle: state.project.title,
    artifactIds: state.artifacts.map((artifact) => artifact.id),
    issueIds: state.issues.map((issue) => issue.id),
    ...pkg,
  };
  return { ...state, publishedPackages: [...state.publishedPackages, full] };
}

describe('deletion impact planning', () => {
  it('previews placements and cascaded findings for a placed object', () => {
    const state = seed();
    const plan = planArtifactDelete(state, 'artifact-tape', NOW);

    expect(plan.totalReferences).toBe(2); // one placement + one finding
    const placementGroup = plan.groups.find((group) => group.key === 'placements');
    expect(placementGroup?.items[0]).toContain('Afterlives');
    const issueGroup = plan.groups.find((group) => group.key === 'issues');
    expect(issueGroup?.items.some((item) => item.includes('Add transcript beside oral history station'))).toBe(true);

    const deleted = applyDeletion(state, plan.record);
    expect(deleted.artifacts.some((artifact) => artifact.id === 'artifact-tape')).toBe(false);
    expect(deleted.zones.find((zone) => zone.id === 'zone-after')?.artifactIds).not.toContain('artifact-tape');
    expect(deleted.issues.some((issue) => issue.artifactId === 'artifact-tape')).toBe(false);
    // The audit record holds the full graph.
    expect(deleted.deletionRecords[0].placements).toHaveLength(1);
    expect(deleted.deletionRecords[0].cascadeIssues).toHaveLength(1);
  });

  it('previews an object with findings but no placements', () => {
    const state = seed();
    const quilt = state.artifacts.find((artifact) => artifact.id === 'artifact-quilt') as Artifact;
    const withoutPlacement: WorkspaceState = {
      ...state,
      zones: state.zones.map((zone) => ({ ...zone, artifactIds: zone.artifactIds.filter((id) => id !== quilt.id) })),
    };
    const plan = planArtifactDelete(withoutPlacement, quilt.id, NOW);
    expect(plan.groups.some((group) => group.key === 'placements')).toBe(false);
    expect(plan.groups.find((group) => group.key === 'issues')?.items[0]).toContain('Confirm quilt lux rotation');
  });

  it('reports an empty impact set for an unlinked record (empty finding)', () => {
    const state = seed();
    const loneIssue: ReviewIssue = {
      id: 'issue-lone',
      title: 'A note without links',
      description: 'Completely standalone finding with no object or area.',
      severity: 'note',
      status: 'open',
      owner: 'Noa',
      createdAt: '2026-09-02T10:00:00.000Z',
      updatedAt: '2026-09-02T10:00:00.000Z',
    };
    const plan = planIssueDelete({ ...state, issues: [...state.issues, loneIssue] }, loneIssue.id, NOW);
    expect(plan.totalReferences).toBe(0);
    expect(plan.groups[0].items).toContain('This finding is not linked to any object or area.');
  });

  it('detaches rather than deletes objects and findings when deleting a zone', () => {
    const state = seed();
    const plan = planZoneDelete(state, 'zone-after', NOW);
    expect(plan.record.placements.map((placement) => placement.action)).toEqual(['detached', 'detached']);
    expect(plan.record.detachments.map((detachment) => detachment.issueId)).toEqual(['issue-audio-transcript']);

    const deleted = applyDeletion(state, plan.record);
    expect(deleted.zones.some((zone) => zone.id === 'zone-after')).toBe(false);
    // Objects survive and return to the unplaced queue.
    expect(deleted.artifacts.some((artifact) => artifact.id === 'artifact-tape')).toBe(true);
    expect(deleted.issues.find((issue) => issue.id === 'issue-audio-transcript')?.zoneId).toBeUndefined();
  });

  it('does not rewrite published packages and lists them in the impact preview', () => {
    const withPackage = withPublishedPackage(seed(), { artifactIds: ['artifact-tape'], issueIds: ['issue-audio-transcript'] });
    const plan = planArtifactDelete(withPackage, 'artifact-tape', NOW);
    expect(plan.record.publishedPackageIds).toHaveLength(1);
    const packageGroup = plan.groups.find((group) => group.key === 'publishedPackages');
    expect(packageGroup?.items.join(' ')).toContain('stays exactly as exported');

    const deleted = applyDeletion(withPackage, plan.record);
    expect(deleted.publishedPackages).toEqual(withPackage.publishedPackages);
    expect(deleted.publishedPackages[0].artifactIds).toContain('artifact-tape');
  });

  it('warns that the readiness sign-off regresses on delete', () => {
    const ready: WorkspaceState = { ...seed(), project: { ...seed().project, stage: 'ready' } };
    const plan = planIssueDelete(ready, 'issue-quilt-light', NOW);
    expect(plan.groups.some((group) => group.key === 'signoff')).toBe(true);
  });
});

describe('restore after delete', () => {
  it('restores a placed object, its placement position, and cascaded findings exactly', () => {
    const state = seed();
    const plan = planArtifactDelete(state, 'artifact-tape', NOW);
    const deleted = applyDeletion(state, plan.record);

    const analysis = analyzeRestore(deleted, plan.record.id, NOW);
    expect(analysis.hasBlocking).toBe(false);
    const { state: restored } = commitRestore(deleted, plan.record.id, {}, NOW);
    expect(restored.artifacts.some((artifact) => artifact.id === 'artifact-tape')).toBe(true);
    expect(restored.zones.find((zone) => zone.id === 'zone-after')?.artifactIds).toEqual(['artifact-bowl', 'artifact-tape']);
    const issue = restored.issues.find((candidate) => candidate.id === 'issue-audio-transcript');
    expect(issue?.artifactId).toBe('artifact-tape');
    expect(issue?.zoneId).toBe('zone-after');
    expect(getDeletionStatus(restored.deletionRecords[0], NOW.getTime())).toBe('restored');
  });

  it('restores a deleted zone and pulls detached placements back into sequence', () => {
    const state = seed();
    const plan = planZoneDelete(state, 'zone-after', NOW);
    const deleted = applyDeletion(state, plan.record);
    expect(deleted.zones).toHaveLength(3);

    const { state: restored } = commitRestore(deleted, plan.record.id, {}, NOW);
    const zone = restored.zones.find((candidate) => candidate.id === 'zone-after') as Zone;
    expect(zone).toBeDefined();
    expect(zone.artifactIds).toEqual(['artifact-bowl', 'artifact-tape']);
    expect(restored.issues.find((issue) => issue.id === 'issue-audio-transcript')?.zoneId).toBe('zone-after');
  });

  it('detaches links when restoring a finding whose target disappeared', () => {
    const state = seed();
    const plan = planIssueDelete(state, 'issue-audio-transcript', NOW);
    const deleted = applyDeletion(state, plan.record);
    // The linked zone and object are also removed before the restore attempt.
    const drifted: WorkspaceState = {
      ...deleted,
      zones: deleted.zones.filter((zone) => zone.id !== 'zone-after'),
      artifacts: deleted.artifacts.filter((artifact) => artifact.id !== 'artifact-tape'),
    };
    const analysis = analyzeRestore(drifted, plan.record.id, NOW);
    expect(analysis.conflicts.filter((item) => item.severity === 'warning')).toHaveLength(2);

    const { state: restored } = commitRestore(drifted, plan.record.id, {}, NOW);
    const issue = restored.issues.find((candidate) => candidate.id === 'issue-audio-transcript') as ReviewIssue;
    expect(issue).toBeDefined();
    expect(issue.zoneId).toBeUndefined();
    expect(issue.artifactId).toBeUndefined();
  });
});

describe('restore conflicts from mid-flight edits', () => {
  it('flags an accession ID collision as blocking and refuses a blind overwrite', () => {
    const state = seed();
    const plan = planArtifactDelete(state, 'artifact-gloves', NOW);
    const deleted = applyDeletion(state, plan.record);

    // After the delete, another object claims the same accession identifier.
    const replacement: Artifact = {
      ...(plan.record.artifact as Artifact),
      id: createId('artifact'),
      title: 'Newer Gloves Record',
      createdAt: '2026-09-11T08:00:00.000Z',
      updatedAt: '2026-09-11T08:00:00.000Z',
    };
    const drifted = { ...deleted, artifacts: [...deleted.artifacts, replacement] };

    const analysis = analyzeRestore(drifted, plan.record.id, NOW);
    const collision = analysis.conflicts.find((item) => item.id === 'accession-collision');
    expect(collision?.severity).toBe('blocking');
    expect(collision?.options).toEqual(['skip']);

    expect(() => commitRestore(drifted, plan.record.id, {}, NOW)).toThrow(/resolve the conflicts/i);
    // Explicitly skipping leaves the current plan untouched.
    const { state: skipped } = commitRestore(drifted, plan.record.id, { 'accession-collision': 'skip' }, NOW);
    expect(skipped.artifacts.some((artifact) => artifact.title === 'Newer Gloves Record')).toBe(true);
    expect(skipped.artifacts.some((artifact) => artifact.id === plan.record.targetId)).toBe(false);
    expect(skipped.deletionRecords[0].restoredAt).toBeUndefined();
  });

  it('offers overwrite or skip when the same object record was recreated', () => {
    const state = seed();
    const plan = planArtifactDelete(state, 'artifact-bowl', NOW);
    const deleted = applyDeletion(state, plan.record);
    const edited: Artifact = {
      ...(plan.record.artifact as Artifact),
      summary: 'The curator added new provenance notes after the deletion.',
      updatedAt: '2026-09-11T09:00:00.000Z',
    };
    const drifted = { ...deleted, artifacts: [...deleted.artifacts, edited] };

    const analysis = analyzeRestore(drifted, plan.record.id, NOW);
    const primary = analysis.conflicts.find((item) => item.id === 'primary-record');
    expect(primary?.severity).toBe('blocking');
    expect(primary?.options).toContain('overwrite');
    expect(primary?.message).toContain('edited after the deletion');

    // Default safe choice requires an explicit decision; skipping keeps the current record.
    expect(() => commitRestore(drifted, plan.record.id, {}, NOW)).toThrow(/resolve the conflicts/i);
    const { state: kept } = commitRestore(drifted, plan.record.id, { 'primary-record': 'skip' }, NOW);
    expect(kept.artifacts.find((artifact) => artifact.id === edited.id)?.summary).toContain('provenance');

    // Explicit overwrite brings the deleted version back.
    const { state: overwritten, report } = commitRestore(drifted, plan.record.id, { 'primary-record': 'overwrite' }, NOW);
    expect(overwritten.artifacts.find((artifact) => artifact.id === edited.id)?.summary).toBe((plan.record.artifact as Artifact).summary);
    expect(report.lines.some((line) => line.outcome === 'overwritten')).toBe(true);
  });

  it('detects when an object was placed elsewhere while deleted', () => {
    const state = seed();
    const plan = planArtifactDelete(state, 'artifact-tape', NOW);
    const deleted = applyDeletion(state, plan.record);
    const drifted: WorkspaceState = {
      ...deleted,
      zones: deleted.zones.map((zone) =>
        zone.id === 'zone-patterns' ? { ...zone, artifactIds: [...zone.artifactIds, 'artifact-tape'] } : zone,
      ),
      artifacts: [...deleted.artifacts, plan.record.artifact as Artifact],
    };
    const analysis = analyzeRestore(drifted, plan.record.id, NOW);
    const placementConflict = analysis.conflicts.find((item) => item.subject === 'placement');
    expect(placementConflict?.options).toEqual(['skip', 'overwrite']);

    const { state: restored } = commitRestore(drifted, plan.record.id, { [placementConflict!.id]: 'overwrite' }, NOW);
    expect(restored.zones.find((zone) => zone.id === 'zone-patterns')?.artifactIds).not.toContain('artifact-tape');
    expect(restored.zones.find((zone) => zone.id === 'zone-after')?.artifactIds).toContain('artifact-tape');
  });

  it('warns on zone sequence and name collisions without blocking restore', () => {
    const state = seed();
    const plan = planZoneDelete(state, 'zone-after', NOW);
    const deleted = applyDeletion(state, plan.record);
    const replacement: Zone = {
      ...(plan.record.zone as Zone),
      id: createId('zone'),
      shortLabel: 'Renamed',
      name: 'Afterlives',
      sequence: 3,
      artifactIds: [],
    };
    const drifted = { ...deleted, zones: [...deleted.zones, replacement] };
    const analysis = analyzeRestore(drifted, plan.record.id, NOW);
    expect(analysis.hasBlocking).toBe(false);
    expect(analysis.conflicts.some((item) => item.id === 'zone-name')).toBe(true);
    expect(analysis.conflicts.some((item) => item.id === 'zone-sequence')).toBe(true);

    const { state: restored } = commitRestore(drifted, plan.record.id, { 'zone-sequence': 'overwrite' }, NOW);
    expect(restored.zones.find((zone) => zone.id === plan.record.targetId)?.sequence).toBe(3);
  });

  it('cannot restore after the recovery window closes but keeps the audit entry', () => {
    const state = seed();
    const plan = planArtifactDelete(state, 'artifact-bowl', NOW);
    const deleted = applyDeletion(state, plan.record);
    const later = new Date(NOW.getTime() + RESTORE_WINDOW_MS + 1);
    expect(getDeletionStatus(plan.record, later.getTime())).toBe('expired');
    expect(() => commitRestore(deleted, plan.record.id, {}, later)).toThrow(/recovery window/i);
    expect(deleted.deletionRecords).toHaveLength(1);
  });
});

describe('audit retention', () => {
  it('prunes deletion records and reports only past the audit horizon', () => {
    const state = seed();
    const oldPlan = planArtifactDelete(state, 'artifact-bowl', new Date(NOW.getTime() - AUDIT_HORIZON_MS - 1));
    const recentPlan = planArtifactDelete(state, 'artifact-radio', NOW);
    const withHistory: WorkspaceState = {
      ...state,
      artifacts: state.artifacts.filter((artifact) => artifact.id !== 'artifact-bowl' && artifact.id !== 'artifact-radio'),
      deletionRecords: [recentPlan.record, oldPlan.record],
      restoreReports: [
        { recordId: recentPlan.record.id, restoredAt: NOW.toISOString(), lines: [] },
        { recordId: oldPlan.record.id, restoredAt: new Date(NOW.getTime() - AUDIT_HORIZON_MS - 1).toISOString(), lines: [] },
      ],
    };
    const pruned = pruneDeletionHistory(withHistory, NOW.getTime());
    expect(pruned.deletionRecords.map((record) => record.targetLabel)).toEqual(['Kitchen Table Radio']);
    expect(pruned.restoreReports).toHaveLength(1);
  });
});
