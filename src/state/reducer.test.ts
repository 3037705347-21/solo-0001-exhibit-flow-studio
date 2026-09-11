import { describe, expect, it } from 'vitest';
import { workspaceReducer } from './reducer';
import { createSeedWorkspace } from './seed';
import { artifactFromDraft, emptyArtifactDraft } from '../domain/artifactValidation';
import type { Artifact } from '../domain/models';

function newArtifact(accessionId: string): Artifact {
  return artifactFromDraft({
    ...emptyArtifactDraft,
    accessionId,
    title: `Object ${accessionId}`,
    maker: 'Maker',
    medium: 'Metal',
    summary: 'A sufficiently long summary so the draft builds into a valid artifact.',
    width: '10',
    height: '12',
    depth: '3',
    dwellMinutes: '3',
  });
}

describe('workspaceReducer artifacts/import', () => {
  it('appends new artifacts in file order in one commit', () => {
    const initial = createSeedWorkspace();
    const before = initial.artifacts.length;
    const next = workspaceReducer(initial, {
      type: 'artifacts/import',
      artifacts: [newArtifact('AF-BATCH-1'), newArtifact('AF-BATCH-2')],
    });
    expect(next.artifacts).toHaveLength(before + 2);
    expect(next.artifacts.slice(-2).map((artifact) => artifact.accessionId)).toEqual(['AF-BATCH-1', 'AF-BATCH-2']);
    // Journey queue derives from artifacts: both new objects are unplaced but referenced.
    const placedIds = new Set(next.zones.flatMap((zone) => zone.artifactIds));
    expect(next.artifacts.slice(-2).some((artifact) => placedIds.has(artifact.id))).toBe(false);
  });

  it('replaces allowed updates in place, preserving placements', () => {
    const initial = createSeedWorkspace();
    const target = initial.artifacts[0];
    const updated: Artifact = { ...target, title: 'Updated Title', dwellMinutes: 9 };
    const next = workspaceReducer(initial, { type: 'artifacts/import', artifacts: [updated] });
    const after = next.artifacts.find((artifact) => artifact.id === target.id);
    expect(after?.title).toBe('Updated Title');
    expect(next.artifacts).toHaveLength(initial.artifacts.length);
    // Update replaces in place, so existing zone placements are preserved.
    expect(next.zones.some((zone) => zone.artifactIds.includes(target.id))).toBe(true);
  });

  it('leaves state untouched when the batch clashes with an existing accession id', () => {
    const initial = createSeedWorkspace();
    const clashId = initial.artifacts[0].accessionId;
    const clash = newArtifact(clashId.toLowerCase());
    expect(() => workspaceReducer(initial, { type: 'artifacts/import', artifacts: [clash] })).toThrow();
  });

  it('rejects an empty batch', () => {
    const initial = createSeedWorkspace();
    expect(() => workspaceReducer(initial, { type: 'artifacts/import', artifacts: [] })).toThrow();
  });
});
