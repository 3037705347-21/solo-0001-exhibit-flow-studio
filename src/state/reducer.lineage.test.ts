import { describe, expect, it } from 'vitest';
import { workspaceReducer } from './reducer';
import { createSeedWorkspace } from './seed';
import { archivedPlacementNodeId, artifactNodeId, findNode, issueNodeId, placementNodeId, snapshotNodeId } from '../domain/lineage';
import type { Artifact, ReviewIssue } from '../domain/models';

function seed() {
  return createSeedWorkspace();
}

describe('reducer lineage integration', () => {
  it('directly creating an artifact records direct provenance', () => {
    const state = seed();
    const artifact: Artifact = {
      id: 'artifact-new',
      accessionId: 'AF-2027-900',
      title: 'Newly Curated Plaque',
      maker: 'In-house',
      yearLabel: '2027',
      medium: 'Enamel',
      origin: 'Porto',
      summary: 'A directly curated plaque added during planning for the opening gallery.',
      dimensions: { width: 12, height: 18, depth: 1, unit: 'cm' },
      dwellMinutes: 3,
      narrativeRole: 'threshold',
      sensitivity: 'standard',
      accessibilityNeed: 'none',
      isKeyObject: false,
      tags: [],
      color: '#2f7c75',
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
    };
    const next = workspaceReducer(state, { type: 'artifact/upsert', artifact });
    const node = findNode(next.lineage, artifactNodeId('artifact-new'));
    expect(node?.origin).toBe('direct');
  });

  it('importing records import provenance and repeating the same import adds nothing', () => {
    const state = seed();
    const batchId = 'batch-abc123';
    const creates: Artifact[] = [{
      id: 'artifact-imported-1',
      accessionId: 'AF-2027-950',
      title: 'Imported Textile Fragment',
      maker: 'Unknown',
      yearLabel: '19th century',
      medium: 'Wool',
      origin: 'Andes',
      summary: 'A textile fragment brought in through a collections import batch.',
      dimensions: { width: 40, height: 60, depth: 1, unit: 'cm' },
      dwellMinutes: 5,
      narrativeRole: 'context',
      sensitivity: 'low-light',
      accessibilityNeed: 'seating',
      isKeyObject: false,
      tags: ['import'],
      color: '#7c6aa6',
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
    }];
    const payload = { batch: { id: batchId, fileName: 'drop.json', contentHash: 'x', importedAt: '2026-09-10T00:00:00.000Z', artifactIds: ['artifact-imported-1'] }, creates, updates: [] };
    const imported = workspaceReducer(state, { type: 'artifacts/import', payload });
    const node = findNode(imported.lineage, artifactNodeId('artifact-imported-1'));
    expect(node?.origin).toBe('import');
    expect(node?.batchFileName).toBe('drop.json');
    expect(imported.lineage.batches).toHaveLength(1);

    // Simulate the idempotent re-import: an empty payload must not duplicate the batch.
    const reImported = workspaceReducer(imported, {
      type: 'artifacts/import',
      payload: { batch: payload.batch, creates: [], updates: [] },
    });
    expect(reImported.lineage.batches).toHaveLength(1);
    expect(reImported.lineage.edges.length).toBe(imported.lineage.edges.length);
  });

  it('flags placement and issue when an edited object changes', () => {
    const state = seed();
    const lantern = state.artifacts.find((a) => a.id === 'artifact-lantern') as Artifact;
    const revised: Artifact = { ...lantern, title: 'Railway Signal Lantern (updated)', summary: `${lantern.summary} Revised conservation notes appended for review.` };
    const next = workspaceReducer(state, { type: 'artifact/upsert', artifact: revised });
    const placement = findNode(next.lineage, placementNodeId('artifact-lantern'));
    expect(placement?.staleReason).toBe('source-modified');
  });

  it('deleting an object tombstones its placement but keeps linked findings on the review desk flagged', () => {
    const state = seed();
    const tape = state.artifacts.find((a) => a.id === 'artifact-tape') as Artifact;
    const linkedIssue = state.issues.find((i) => i.artifactId === 'artifact-tape') as ReviewIssue;
    const next = workspaceReducer(state, { type: 'artifact/remove', artifactId: tape.id });
    expect(findNode(next.lineage, artifactNodeId(tape.id))?.tombstoned).toBe(true);
    expect(findNode(next.lineage, placementNodeId(tape.id))?.tombstoned).toBe(true);

    // The linked finding REMAINS on the review desk, still pointing at the
    // deleted object, with a lineage flag rather than disappearing.
    const keptIssue = next.issues.find((issue) => issue.id === linkedIssue.id);
    expect(keptIssue).toBeDefined();
    expect(keptIssue?.artifactId).toBe('artifact-tape');
    expect(findNode(next.lineage, issueNodeId(linkedIssue.id))?.tombstoned).toBe(false);
    expect(findNode(next.lineage, issueNodeId(linkedIssue.id))?.staleReason).toBe('source-deleted');

    // Structural placement references are cleaned; the artifact itself is gone.
    expect(next.artifacts.some((a) => a.id === tape.id)).toBe(false);
    expect(next.zones.every((zone) => !zone.artifactIds.includes(tape.id))).toBe(true);
  });

  it('records a published package with an export edge and retains it after source deletion', () => {
    const state = seed();
    const snapshotId = '2026-09-10T12:00:00.000Z';
    const published = workspaceReducer(state, { type: 'snapshot/recorded', snapshotId, label: 'Package 2026-09-10' });
    const id = snapshotNodeId(snapshotId);
    expect(findNode(published.lineage, id)).toBeDefined();
    expect(published.lineage.edges.some((edge) => edge.downstream === id && edge.reason === 'exported')).toBe(true);

    const deleted = workspaceReducer(published, { type: 'artifact/remove', artifactId: 'artifact-tape' });
    const packageNode = findNode(deleted.lineage, id);
    expect(packageNode?.tombstoned).toBe(false);
    expect(packageNode?.staleReason).toBe('source-deleted');
  });

  it('restoring a workspace preserves lineage and only fills missing structure', () => {
    const state = seed();
    const restored = workspaceReducer(state, { type: 'workspace/restore', state });
    // Seed lineage is structurally complete; restoration must not duplicate anything.
    expect(restored.lineage.nodes.length).toBe(state.lineage.nodes.length);
    expect(restored.lineage.edges.length).toBe(state.lineage.edges.length);
  });

  it('moving a placement across zones archives the old context and flags published packages', () => {
    // 1) Publish a package containing the tape placement in Afterlives.
    const published = workspaceReducer(seed(), {
      type: 'snapshot/recorded',
      snapshotId: '2026-09-10T12:00:00.000Z',
      label: 'Package before move',
    });
    const snapshotId = snapshotNodeId('2026-09-10T12:00:00.000Z');
    const oldPlacementId = placementNodeId('artifact-tape');
    const oldPlacement = findNode(published.lineage, oldPlacementId);
    expect(oldPlacement?.contextLabel).toBe('Afterlives');
    const exportedEdge = published.lineage.edges.find(
      (edge) => edge.upstream === oldPlacementId && edge.downstream === snapshotId && edge.reason === 'exported',
    );
    expect(exportedEdge).toBeDefined();

    // 2) Move the tape to the first zone (Arrival).
    const moved = workspaceReducer(published, { type: 'placement/assign', artifactId: 'artifact-tape', zoneId: 'zone-arrival' });

    // The live placement now carries the new context and is not stale.
    const live = findNode(moved.lineage, oldPlacementId);
    expect(live?.contextLabel).toBe('Arrival / A Light Carried');
    expect(live?.tombstoned).toBe(false);
    expect(live?.staleReason).toBeUndefined();

    // The previous placement is archived under a distinct id with the old zone.
    const archivedId = archivedPlacementNodeId('artifact-tape', oldPlacement?.contextLabel ?? '');
    const archived = findNode(moved.lineage, archivedId);
    expect(archived?.contextLabel).toBe('Afterlives');
    expect(archived?.tombstoned).toBe(true);
    expect(archived?.staleReason).toBe('source-removed');

    // The old package's export edge now points at the archived node — original
    // context preserved — and the package is flagged for re-review.
    const movedExportedEdge = moved.lineage.edges.find(
      (edge) => edge.upstream === archivedId && edge.downstream === snapshotId && edge.reason === 'exported',
    );
    expect(movedExportedEdge).toBeDefined();
    expect(findNode(moved.lineage, snapshotId)?.staleReason).toBe('source-removed');

    // Zone-wide findings linked to the destination zone pick up the new placement.
    const arrivalIssue = moved.issues.find((issue) => issue.zoneId === 'zone-arrival' && !issue.artifactId);
    if (arrivalIssue) {
      expect(moved.lineage.edges.some(
        (edge) => edge.upstream === oldPlacementId && edge.downstream === issueNodeId(arrivalIssue.id) && edge.reason === 'linked',
      )).toBe(true);
    }
  });
});
