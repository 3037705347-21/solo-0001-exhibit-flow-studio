import { describe, expect, it } from 'vitest';
import { analyzeJourney } from '../domain/journeyAnalysis';
import type { Artifact, WorkspaceState } from '../domain/models';
import { RevisionConflictError, revisionsForArtifact, TRACKED_ARTIFACT_FIELDS } from '../domain/revisions';
import { buildSnapshot, evaluateReadiness } from '../domain/reviewRules';
import { loadWorkspace, saveWorkspace, STORAGE_KEY } from './persistence';
import { workspaceReducer } from './reducer';
import { selectArtifactZone } from './selectors';
import { createSeedWorkspace } from './seed';

function artifact(state: WorkspaceState, artifactId: string): Artifact {
  const found = state.artifacts.find((candidate) => candidate.id === artifactId);
  if (!found) throw new Error(`Artifact ${artifactId} missing from state.`);
  return found;
}

function editArtifact(state: WorkspaceState, artifactId: string, patch: Partial<Artifact>, reason = 'Curatorial correction.'): WorkspaceState {
  const current = artifact(state, artifactId);
  const next: Artifact = {
    ...current,
    ...patch,
    id: current.id,
    revision: current.revision + 1,
    updatedAt: '2026-09-12T10:00:00.000Z',
  };
  return workspaceReducer(state, { type: 'artifact/upsert', artifact: next, reason, baseVersion: current.revision });
}

function restoreField(state: WorkspaceState, artifactId: string, version: number, field: string): WorkspaceState {
  const source = state.revisions.find((revision) => revision.artifactId === artifactId && revision.version === version);
  if (!source) throw new Error(`Revision v${version} missing for ${artifactId}.`);
  return workspaceReducer(state, {
    type: 'artifact/restore-field',
    artifactId,
    revisionId: source.id,
    field,
    reason: `Restored ${field} from version ${version}.`,
    baseVersion: artifact(state, artifactId).revision,
  });
}

function restoreRevision(state: WorkspaceState, artifactId: string, version: number): WorkspaceState {
  const source = state.revisions.find((revision) => revision.artifactId === artifactId && revision.version === version);
  if (!source) throw new Error(`Revision v${version} missing for ${artifactId}.`);
  return workspaceReducer(state, {
    type: 'artifact/restore-revision',
    artifactId,
    revisionId: source.id,
    reason: `Restored the full record to version ${version}.`,
    baseVersion: artifact(state, artifactId).revision,
  });
}

function fakeStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } as unknown as Storage;
}

describe('revision chain recording', () => {
  it('records before/after values, reason, time, and current version for every change', () => {
    const seed = createSeedWorkspace();
    const state = editArtifact(seed, 'artifact-lantern', { title: 'Signal Lantern (Conserved)' }, 'Conservation report 2026-09.');
    const chain = revisionsForArtifact(state.revisions, 'artifact-lantern');
    expect(chain.map((revision) => revision.version)).toEqual([1, 2]);
    const edit = chain[1];
    expect(edit.kind).toBe('edit');
    expect(edit.reason).toBe('Conservation report 2026-09.');
    expect(edit.changedAt).toBeTruthy();
    expect(edit.changes).toEqual([{ field: 'title', before: 'Railway Signal Lantern', after: 'Signal Lantern (Conserved)' }]);
    expect(edit.version).toBe(artifact(state, 'artifact-lantern').revision);
    expect(edit.snapshot.title).toBe('Signal Lantern (Conserved)');
  });

  it('ignores saves that change nothing instead of appending empty revisions', () => {
    const seed = createSeedWorkspace();
    const state = editArtifact(seed, 'artifact-lantern', {});
    expect(state.revisions).toHaveLength(seed.revisions.length);
    expect(artifact(state, 'artifact-lantern').revision).toBe(1);
  });
});

describe('single-field restore', () => {
  it('restores one field from an earlier revision and records the restore as a new revision', () => {
    const seed = createSeedWorkspace();
    let state = editArtifact(seed, 'artifact-lantern', { title: 'Signal Lantern (Conserved)', dwellMinutes: 6 }, 'Conservation report.');
    state = editArtifact(state, 'artifact-lantern', { title: 'Lantern, Railway Signal' }, 'Registrar style pass.');
    expect(artifact(state, 'artifact-lantern').revision).toBe(3);

    state = restoreField(state, 'artifact-lantern', 2, 'title');

    const restored = artifact(state, 'artifact-lantern');
    expect(restored.title).toBe('Signal Lantern (Conserved)');
    expect(restored.dwellMinutes).toBe(6);
    expect(restored.id).toBe('artifact-lantern');
    expect(restored.revision).toBe(4);

    const chain = revisionsForArtifact(state.revisions, 'artifact-lantern');
    expect(chain.map((revision) => revision.version)).toEqual([1, 2, 3, 4]);
    const restore = chain.at(-1);
    expect(restore?.kind).toBe('restore-field');
    expect(restore?.reason).toContain('version 2');
    expect(restore?.changes).toEqual([{ field: 'title', before: 'Lantern, Railway Signal', after: 'Signal Lantern (Conserved)' }]);
    expect(restore?.snapshot.revision).toBe(4);
  });

  it('restores structured fields like dimensions without sharing references with the snapshot', () => {
    const seed = createSeedWorkspace();
    let state = editArtifact(seed, 'artifact-lantern', { dimensions: { width: 40, height: 50, depth: 30, unit: 'cm' } }, 'Remeasured for the new case.');
    state = restoreField(state, 'artifact-lantern', 1, 'dimensions');
    const restored = artifact(state, 'artifact-lantern');
    expect(restored.dimensions).toEqual({ width: 19, height: 34, depth: 18, unit: 'cm' });
    const snapshot = state.revisions.find((revision) => revision.artifactId === 'artifact-lantern' && revision.version === 1);
    expect(restored.dimensions).not.toBe(snapshot?.snapshot.dimensions);
  });
});

describe('whole-object restore', () => {
  it('restores every tracked field to an earlier revision while preserving identity', () => {
    const seed = createSeedWorkspace();
    const original = artifact(seed, 'artifact-lantern');
    let state = editArtifact(seed, 'artifact-lantern', {
      title: 'Changed Title',
      dimensions: { width: 1, height: 2, depth: 3, unit: 'cm' },
      narrativeRole: 'reflection',
      accessibilityNeed: 'audio',
    }, 'Experimental reclassification.');
    state = editArtifact(state, 'artifact-lantern', { medium: 'Steel and glass' }, 'Medium corrected.');

    state = restoreRevision(state, 'artifact-lantern', 1);

    const restored = artifact(state, 'artifact-lantern');
    for (const field of TRACKED_ARTIFACT_FIELDS) {
      expect(restored[field]).toEqual(original[field]);
    }
    expect(restored.id).toBe('artifact-lantern');
    expect(restored.createdAt).toBe(original.createdAt);
    expect(restored.revision).toBe(4);

    const chain = revisionsForArtifact(state.revisions, 'artifact-lantern');
    const restore = chain.at(-1);
    expect(restore?.kind).toBe('restore-object');
    expect(restore?.changes.map((change) => change.field)).toEqual(expect.arrayContaining(['title', 'dimensions', 'narrativeRole', 'accessibilityNeed', 'medium']));

    state = restoreRevision(state, 'artifact-lantern', 2);
    expect(artifact(state, 'artifact-lantern').title).toBe('Changed Title');
    expect(artifact(state, 'artifact-lantern').revision).toBe(5);
    expect(revisionsForArtifact(state.revisions, 'artifact-lantern')).toHaveLength(5);
  });
});

describe('association invariance', () => {
  it('keeps placement, findings, readiness, and export bound to the same object identity across edits and restores', () => {
    const seed = createSeedWorkspace();
    let state = editArtifact(seed, 'artifact-tape', { title: 'Oral History Tape Twelve', accessibilityNeed: 'tactile-alternative' }, 'Accessibility review.');
    state = restoreField(state, 'artifact-tape', 1, 'accessibilityNeed');
    state = restoreRevision(state, 'artifact-tape', 1);

    expect(selectArtifactZone(state, 'artifact-tape')?.id).toBe('zone-after');
    expect(state.zones.find((zone) => zone.id === 'zone-after')?.artifactIds).toContain('artifact-tape');
    expect(state.issues.find((issue) => issue.id === 'issue-audio-transcript')?.artifactId).toBe('artifact-tape');
    expect(state.artifacts.filter((candidate) => candidate.id === 'artifact-tape')).toHaveLength(1);
    expect(state.artifacts).toHaveLength(seed.artifacts.length);

    const resolved = workspaceReducer(state, { type: 'issue/transition', issueId: 'issue-audio-transcript', status: 'resolved' });
    const analysis = analyzeJourney(resolved.artifacts, resolved.zones);
    const readiness = evaluateReadiness(resolved, analysis);
    expect(readiness.ready).toBe(true);

    const snapshot = buildSnapshot(resolved, analysis, readiness);
    const exported = snapshot.zones.find((zone) => zone.id === 'zone-after')?.artifacts.find((candidate) => candidate.id === 'artifact-tape');
    expect(exported?.title).toBe('Oral History Tape 12');
    expect(exported?.accessibilityNeed).toBe('audio');
  });

  it('never lets an old revision create a second object with the same identity', () => {
    const seed = createSeedWorkspace();
    let state = editArtifact(seed, 'artifact-lantern', { title: 'Interim Title' });
    state = restoreRevision(state, 'artifact-lantern', 1);
    const ids = state.artifacts.map((candidate) => candidate.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(state.revisions.every((revision) => state.artifacts.some((candidate) => candidate.id === revision.artifactId))).toBe(true);
  });
});

describe('conflicting modification', () => {
  it('rejects an edit based on a stale version and keeps the newer work intact', () => {
    const seed = createSeedWorkspace();
    const stateA = editArtifact(seed, 'artifact-lantern', { title: 'Session A Title' }, 'Session A.');
    const staleBase = artifact(seed, 'artifact-lantern');
    const staleEdit: Artifact = { ...staleBase, title: 'Session B Title', revision: staleBase.revision + 1, updatedAt: '2026-09-12T11:00:00.000Z' };

    expect(() => workspaceReducer(stateA, {
      type: 'artifact/upsert',
      artifact: staleEdit,
      reason: 'Session B.',
      baseVersion: staleBase.revision,
    })).toThrow(RevisionConflictError);

    expect(artifact(stateA, 'artifact-lantern').title).toBe('Session A Title');
    expect(artifact(stateA, 'artifact-lantern').revision).toBe(2);
    expect(revisionsForArtifact(stateA.revisions, 'artifact-lantern')).toHaveLength(2);
  });

  it('rejects edits that carry no base version at all', () => {
    const seed = createSeedWorkspace();
    const current = artifact(seed, 'artifact-lantern');
    const blind: Artifact = { ...current, title: 'Blind Overwrite', revision: current.revision + 1 };
    expect(() => workspaceReducer(seed, { type: 'artifact/upsert', artifact: blind, reason: 'No base.' })).toThrow(RevisionConflictError);
  });

  it('rejects a restore issued after someone else modified the object', () => {
    const seed = createSeedWorkspace();
    const stateA = editArtifact(seed, 'artifact-lantern', { title: 'Session A Title' });
    const source = stateA.revisions.find((revision) => revision.artifactId === 'artifact-lantern' && revision.version === 1);
    expect(source).toBeDefined();
    try {
      workspaceReducer(stateA, {
        type: 'artifact/restore-revision',
        artifactId: 'artifact-lantern',
        revisionId: source?.id ?? '',
        reason: 'Stale restore.',
        baseVersion: 1,
      });
      expect.unreachable('stale restore must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(RevisionConflictError);
      expect((error as RevisionConflictError).currentVersion).toBe(2);
      expect((error as RevisionConflictError).baseVersion).toBe(1);
    }
    expect(artifact(stateA, 'artifact-lantern').title).toBe('Session A Title');
  });
});

describe('history after refresh', () => {
  it('persists the full revision chain through storage and keeps restores working after reload', () => {
    const storage = fakeStorage();
    const seed = createSeedWorkspace();
    let state = editArtifact(seed, 'artifact-lantern', { title: 'Refreshed Title' }, 'First correction.');
    state = editArtifact(state, 'artifact-lantern', { dwellMinutes: 9 }, 'Timing update.');
    state = restoreField(state, 'artifact-lantern', 1, 'title');
    expect(saveWorkspace(state, storage)).toBe(true);

    const reloaded = loadWorkspace(storage);
    const chain = revisionsForArtifact(reloaded.revisions, 'artifact-lantern');
    expect(chain.map((revision) => revision.version)).toEqual([1, 2, 3, 4]);
    expect(chain.map((revision) => revision.kind)).toEqual(['create', 'edit', 'edit', 'restore-field']);
    expect(chain[1].reason).toBe('First correction.');
    expect(chain.every((revision) => Boolean(revision.changedAt))).toBe(true);

    const current = artifact(reloaded, 'artifact-lantern');
    expect(current.revision).toBe(4);
    expect(current.title).toBe('Railway Signal Lantern');
    expect(current.dwellMinutes).toBe(9);
    expect(chain.at(-1)?.version).toBe(current.revision);

    const restored = restoreRevision(reloaded, 'artifact-lantern', 2);
    expect(artifact(restored, 'artifact-lantern').title).toBe('Refreshed Title');
    expect(artifact(restored, 'artifact-lantern').revision).toBe(5);
  });

  it('upgrades stored workspaces that predate the revision chain', () => {
    const storage = fakeStorage();
    const legacy = JSON.parse(JSON.stringify(createSeedWorkspace())) as Record<string, unknown> & { artifacts: Array<Record<string, unknown>> };
    delete legacy.revisions;
    for (const legacyArtifact of legacy.artifacts) delete legacyArtifact.revision;
    storage.setItem(STORAGE_KEY, JSON.stringify(legacy));

    const loaded = loadWorkspace(storage);
    expect(artifact(loaded, 'artifact-lantern').revision).toBe(1);
    const chain = revisionsForArtifact(loaded.revisions, 'artifact-lantern');
    expect(chain).toHaveLength(1);
    expect(chain[0].kind).toBe('create');
    expect(chain[0].snapshot.title).toBe('Railway Signal Lantern');

    const edited = editArtifact(loaded, 'artifact-lantern', { title: 'Post-upgrade Title' });
    expect(artifact(edited, 'artifact-lantern').revision).toBe(2);
    expect(revisionsForArtifact(edited.revisions, 'artifact-lantern').map((revision) => revision.version)).toEqual([1, 2]);
  });
});
