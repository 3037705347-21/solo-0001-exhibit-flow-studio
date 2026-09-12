import { describe, expect, it } from 'vitest';
import { createSeedWorkspace } from '../state/seed';
import {
  acknowledgeStaleness,
  artifactNodeId,
  artifactSignature,
  downstreamClosure,
  EMPTY_LINEAGE,
  findNode,
  issueNodeId,
  noteArtifactRemoved,
  noteArtifactUpserted,
  noteIssueAdded,
  notePlacementAssigned,
  notePlacementRemoved,
  placementNodeId,
  previewSnapshotDependencies,
  reconcileLineage,
  recordSnapshot,
} from './lineage';
import type { Artifact, ReviewIssue, WorkspaceState, Zone } from './models';

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'artifact-test-1',
    accessionId: 'AF-2027-001',
    title: 'Test Vessel',
    maker: 'Studio',
    yearLabel: '2027',
    medium: 'Ceramic',
    origin: 'Lisbon',
    summary: 'A test object with enough narrative context to be meaningful here.',
    dimensions: { width: 10, height: 12, depth: 8, unit: 'cm' },
    dwellMinutes: 4,
    narrativeRole: 'context',
    sensitivity: 'standard',
    accessibilityNeed: 'none',
    isKeyObject: false,
    tags: [],
    color: '#c9563f',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function zone(overrides: Partial<Zone> = {}): Zone {
  return {
    id: 'zone-1',
    name: 'Entry Hall',
    shortLabel: 'Entry',
    thesis: 'The beginning of the visit.',
    capacityMinutes: 20,
    maxObjects: 5,
    lowLight: false,
    hasSeating: false,
    color: '#2f7c75',
    sequence: 0,
    artifactIds: [],
    ...overrides,
  };
}

function stateWith(lineage = EMPTY_LINEAGE, artifacts: Artifact[] = [], zones: Zone[] = [], issues: ReviewIssue[] = []): WorkspaceState {
  const seed = createSeedWorkspace();
  return { ...seed, artifacts, zones, issues, lineage };
}

describe('lineage: direct creation', () => {
  it('creates an artifact provenance node for a directly created object', () => {
    const { lineage } = noteArtifactUpserted(EMPTY_LINEAGE, artifact(), 'direct');
    const node = findNode(lineage, artifactNodeId('artifact-test-1'));
    expect(node).toBeDefined();
    expect(node?.origin).toBe('direct');
    expect(node?.tombstoned).toBe(false);
    expect(node?.signature).toBe(artifactSignature(artifact()));
  });

  it('records a placement edge when an object is placed in a zone', () => {
    let lineage = noteArtifactUpserted(EMPTY_LINEAGE, artifact(), 'direct').lineage;
    lineage = notePlacementAssigned(lineage, artifact(), zone());
    expect(findNode(lineage, placementNodeId('artifact-test-1'))?.contextLabel).toBe('Entry Hall');
    expect(lineage.edges.some((edge) => edge.upstream === artifactNodeId('artifact-test-1') && edge.downstream === placementNodeId('artifact-test-1'))).toBe(true);
  });

  it('links a finding to its object source', () => {
    let lineage = noteArtifactUpserted(EMPTY_LINEAGE, artifact(), 'direct').lineage;
    lineage = notePlacementAssigned(lineage, artifact(), zone());
    const issue: ReviewIssue = {
      id: 'issue-1',
      title: 'Lighting question',
      description: 'Confirm lux level near the case.',
      severity: 'warning',
      status: 'open',
      artifactId: 'artifact-test-1',
      zoneId: 'zone-1',
      owner: 'Rina',
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    };
    lineage = noteIssueAdded(lineage, issue);
    // The object->issue edge is created; placement->issue is resolved structurally.
    expect(lineage.edges.some((edge) => edge.upstream === artifactNodeId('artifact-test-1') && edge.downstream === issueNodeId('issue-1'))).toBe(true);
  });
});

describe('lineage: reconciliation and existing workspaces', () => {
  it('backfills provenance for workspaces that predate lineage without duplicating edges', () => {
    const seed = createSeedWorkspace();
    const legacy: WorkspaceState = { ...seed, lineage: EMPTY_LINEAGE };
    const once = reconcileLineage(EMPTY_LINEAGE, legacy.artifacts, legacy.zones, legacy.issues, 'backfill');
    const twice = reconcileLineage(once, legacy.artifacts, legacy.zones, legacy.issues, 'backfill');
    expect(twice.nodes.length).toBe(once.nodes.length);
    expect(twice.edges.length).toBe(once.edges.length);
    const assignmentEdges = twice.edges.filter((edge) => edge.reason === 'assigned');
    expect(assignmentEdges.length).toBe(7); // seven placed seed objects
  });

  it('does not wipe a staleness flag when restoring an identical backup', () => {
    const seed = createSeedWorkspace();
    const a = seed.artifacts[0];
    const revisedArtifacts = seed.artifacts.map((item) =>
      item.id === a.id ? { ...a, title: `${a.title} (revised)` } : item);
    let lineage = noteArtifactUpserted(seed.lineage, revisedArtifacts[0], 'direct').lineage;
    lineage = reconcileLineage(lineage, revisedArtifacts, seed.zones, seed.issues, 'backfill');
    const placement = findNode(lineage, placementNodeId(a.id));
    expect(placement?.staleReason).toBe('source-modified');
  });
});

describe('lineage: source modification', () => {
  it('flags placements and findings for re-review when their source object changes', () => {
    let lineage = noteArtifactUpserted(EMPTY_LINEAGE, artifact(), 'direct').lineage;
    lineage = notePlacementAssigned(lineage, artifact(), zone());
    const issue: ReviewIssue = {
      id: 'issue-1',
      title: 'Lighting question',
      description: 'Confirm lux level near the case please.',
      severity: 'warning',
      status: 'open',
      artifactId: 'artifact-test-1',
      owner: 'Rina',
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    };
    lineage = noteIssueAdded(lineage, issue);
    const closure = downstreamClosure(lineage, [artifactNodeId('artifact-test-1')]);
    expect(closure.has(placementNodeId('artifact-test-1'))).toBe(true);
    expect(closure.has(issueNodeId('issue-1'))).toBe(true);

    const revised = artifact({ title: 'Test Vessel (revised title)', summary: 'A changed test object with enough narrative context still.', updatedAt: '2026-09-03T00:00:00.000Z' });
    const result = noteArtifactUpserted(lineage, revised, 'direct');
    expect(result.signatureChanged).toBe(true);
    expect(findNode(result.lineage, placementNodeId('artifact-test-1'))?.staleReason).toBe('source-modified');
    expect(findNode(result.lineage, issueNodeId('issue-1'))?.staleReason).toBe('source-modified');
    // Still-valid records are not tombstoned.
    expect(findNode(result.lineage, placementNodeId('artifact-test-1'))?.tombstoned).toBe(false);
  });

  it('does not flag content-identical edits', () => {
    const first = noteArtifactUpserted(EMPTY_LINEAGE, artifact(), 'direct');
    const second = noteArtifactUpserted(first.lineage, artifact({ updatedAt: '2026-09-04T00:00:00.000Z' }), 'direct');
    expect(second.signatureChanged).toBe(false);
  });

  it('clears the flag when a reviewer acknowledges the record', () => {
    let lineage = noteArtifactUpserted(EMPTY_LINEAGE, artifact(), 'direct').lineage;
    lineage = notePlacementAssigned(lineage, artifact(), zone());
    const revised = artifact({ title: 'Renamed Vessel', updatedAt: '2026-09-03T00:00:00.000Z' });
    lineage = noteArtifactUpserted(lineage, revised, 'direct').lineage;
    expect(findNode(lineage, placementNodeId('artifact-test-1'))?.staleReason).toBe('source-modified');
    lineage = acknowledgeStaleness(lineage, placementNodeId('artifact-test-1'));
    expect(findNode(lineage, placementNodeId('artifact-test-1'))?.staleReason).toBeUndefined();
  });
});

describe('lineage: source deletion', () => {
  it('tombstones the placement and flags findings and packages when an object is deleted', () => {
    let lineage = noteArtifactUpserted(EMPTY_LINEAGE, artifact(), 'direct').lineage;
    lineage = notePlacementAssigned(lineage, artifact(), zone());
    const issue: ReviewIssue = {
      id: 'issue-1',
      title: 'Lighting question',
      description: 'Confirm lux level near the case please.',
      severity: 'warning',
      status: 'open',
      artifactId: 'artifact-test-1',
      owner: 'Rina',
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    };
    lineage = noteIssueAdded(lineage, issue);
    const state = stateWith(lineage, [artifact()], [{ ...zone(), artifactIds: ['artifact-test-1'] }], [issue]);
    lineage = recordSnapshot(lineage, '2026-09-03T00:00:00.000Z', 'Package', state, new Date('2026-09-03T00:00:00.000Z'));

    lineage = noteArtifactRemoved(lineage, 'artifact-test-1', new Date('2026-09-04T00:00:00.000Z'));

    expect(findNode(lineage, artifactNodeId('artifact-test-1'))?.tombstoned).toBe(true);
    expect(findNode(lineage, placementNodeId('artifact-test-1'))?.tombstoned).toBe(true);
    // Findings remain visible (not tombstoned by propagation) but carry the stale flag.
    expect(findNode(lineage, issueNodeId('issue-1'))?.staleReason).toBe('source-deleted');
    expect(findNode(lineage, issueNodeId('issue-1'))?.tombstoned).toBe(false);
    // Published packages are never deleted; they are flagged for re-review.
    const packageNode = lineage.nodes.find((node) => node.type === 'snapshot');
    expect(packageNode?.tombstoned).toBe(false);
    expect(packageNode?.staleReason).toBe('source-deleted');
  });

  it('flags downstream when a placement is removed', () => {
    let lineage = noteArtifactUpserted(EMPTY_LINEAGE, artifact(), 'direct').lineage;
    lineage = notePlacementAssigned(lineage, artifact(), zone());
    const issue: ReviewIssue = {
      id: 'issue-zone',
      title: 'Zone flow concern',
      description: 'The entry sightline needs checking with the team.',
      severity: 'note',
      status: 'open',
      zoneId: 'zone-1',
      owner: 'Theo',
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    };
    lineage = noteIssueAdded(lineage, issue);
    // Structural zone link resolved by reconcile.
    lineage = reconcileLineage(lineage, [artifact()], [{ ...zone(), artifactIds: ['artifact-test-1'] }], [issue], 'direct');
    lineage = notePlacementRemoved(lineage, artifact());
    expect(findNode(lineage, placementNodeId('artifact-test-1'))?.tombstoned).toBe(true);
    expect(findNode(lineage, issueNodeId('issue-zone'))?.staleReason).toBe('source-removed');
  });
});

describe('lineage: export dependency closure', () => {
  it('reports a clean closure for a current plan', () => {
    const state = stateWith(
      createSeedWorkspace().lineage,
      createSeedWorkspace().artifacts,
      createSeedWorkspace().zones,
      createSeedWorkspace().issues,
    );
    const check = previewSnapshotDependencies(state, 'snapshot:prospective');
    expect(check.deletedSources.length).toBe(0);
    expect(check.needsReview.length).toBe(0);
    expect(check.dependencies.length).toBeGreaterThan(10);
  });

  it('flags modified and deleted sources inside the exported closure', () => {
    const seed = createSeedWorkspace();
    const firstArtifact = seed.artifacts[0];
    let lineage = noteArtifactUpserted(seed.lineage, { ...firstArtifact, title: 'Lantern (renamed)' }, 'direct').lineage;
    const deletedArtifact = seed.artifacts.find((item) => item.id === 'artifact-radio') as Artifact;
    lineage = noteArtifactRemoved(lineage, deletedArtifact.id);
    const state: WorkspaceState = { ...seed, lineage };
    const check = previewSnapshotDependencies(state, 'snapshot:prospective');
    const modified = check.needsReview.find((dependency) => dependency.nodeId === placementNodeId(firstArtifact.id));
    expect(modified?.staleReason).toBe('source-modified');
    expect(check.deletedSources.length).toBeGreaterThan(0);
    expect(check.blockers.length).toBeGreaterThan(0);
  });
});
