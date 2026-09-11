import { describe, expect, it } from 'vitest';
import { replayIntents, reviewChanges } from './coordination';
import { createSeedWorkspace } from './seed';
import { workspaceReducer } from './reducer';
import type { Artifact } from '../domain/models';

function seed() {
  return createSeedWorkspace();
}

describe('reviewChanges', () => {
  it('summarizes an object edit and an unrelated finding change as non-overlapping with old and new values', () => {
    const base = seed();
    const local = workspaceReducer(base, {
      type: 'artifact/upsert',
      artifact: { ...base.artifacts[0], title: 'Local Lantern Title' },
    });
    const remote = workspaceReducer(base, { type: 'issue/transition', issueId: base.issues[0].id, status: 'resolved' });
    const review = reviewChanges(base, local, remote);
    expect(review.local).toHaveLength(1);
    expect(review.local[0].entity).toBe('object');
    expect(review.local[0].fields).toContainEqual(expect.objectContaining({
      label: 'Title',
      before: 'Railway Signal Lantern',
      after: 'Local Lantern Title',
    }));
    expect(review.remote).toHaveLength(1);
    expect(review.remote[0].entity).toBe('finding');
    expect(review.remote[0].fields).toContainEqual(expect.objectContaining({ label: 'Status' }));
    expect(review.overlap).toBe(false);
    expect(review.overlapping).toHaveLength(0);
  });

  it('lines up original, local and remote values when both tabs edit the same object', () => {
    const base = seed();
    const local = workspaceReducer(base, { type: 'artifact/upsert', artifact: { ...base.artifacts[0], title: 'Local rename' } });
    const remote = workspaceReducer(base, { type: 'artifact/upsert', artifact: { ...base.artifacts[0], title: 'Remote rename' } });
    const review = reviewChanges(base, local, remote);
    expect(review.overlap).toBe(true);
    expect(review.overlapping).toHaveLength(1);
    const record = review.overlapping[0];
    expect(record.key).toBe(`object:${base.artifacts[0].id}`);
    const titleRow = record.rows.find((row) => row.label === 'Title');
    expect(titleRow).toEqual({
      label: 'Title',
      base: 'Railway Signal Lantern',
      local: 'Local rename',
      remote: 'Remote rename',
    });
  });

  it('describes placement moves made in each tab and only overlaps for the same object', () => {
    const base = seed();
    const [first, second] = [base.artifacts[0].id, base.artifacts[1].id];
    const local = workspaceReducer(base, { type: 'placement/assign', artifactId: first, zoneId: 'zone-patterns' });
    const remote = workspaceReducer(base, { type: 'placement/assign', artifactId: second, zoneId: 'zone-arrival' });
    const review = reviewChanges(base, local, remote);
    expect(review.local[0].entity).toBe('placement');
    expect(review.local[0].kind).toBe('moved');
    expect(review.local[0].fields.some((field) => field.label === 'Zone')).toBe(true);
    expect(review.remote[0].entity).toBe('placement');
    expect(review.overlap).toBe(false);

    const sameObject = workspaceReducer(base, { type: 'placement/assign', artifactId: first, zoneId: 'zone-after' });
    const conflicting = reviewChanges(base, local, sameObject);
    expect(conflicting.overlap).toBe(true);
    expect(conflicting.overlapping[0].rows.some((row) => row.local !== row.remote)).toBe(true);
  });

  it('treats removing an object on one side and placing it on the other as overlapping', () => {
    const base = seed();
    const unplaced = base.artifacts.find((artifact) => !base.zones.some((zone) => zone.artifactIds.includes(artifact.id)))!;
    const local = workspaceReducer(base, { type: 'artifact/remove', artifactId: unplaced.id });
    const remote = workspaceReducer(base, { type: 'placement/assign', artifactId: unplaced.id, zoneId: 'zone-arrival' });
    expect(reviewChanges(base, local, remote).overlap).toBe(true);
  });

  it('reports added and removed findings distinctly', () => {
    const base = seed();
    const now = new Date().toISOString();
    const local = workspaceReducer(base, {
      type: 'issue/add',
      issue: { id: 'issue-new', title: 'Local question', description: 'A sufficiently descriptive local finding body.', severity: 'note', status: 'open', owner: 'Lee', createdAt: now, updatedAt: now },
    });
    const remote = workspaceReducer(base, { type: 'artifact/remove', artifactId: base.artifacts[0].id });
    const review = reviewChanges(base, local, remote);
    expect(review.local[0]).toMatchObject({ entity: 'finding', kind: 'added', title: 'Local question' });
    expect(review.remote.some((change) => change.entity === 'placement' && change.kind === 'removed')).toBe(true);
  });

  it('shows old and new preference values', () => {
    const base = seed();
    const local = workspaceReducer(base, { type: 'preferences/update', preferences: { ...base.preferences, groupSize: 12 } });
    const remote = base;
    const review = reviewChanges(base, local, remote);
    expect(review.local[0].fields).toContainEqual({ label: 'Group size', before: '6 people', after: '12 people' });
  });
});

describe('replayIntents', () => {
  it('replays an object edit on top of an unrelated newer finding change', () => {
    const base = seed();
    const local = workspaceReducer(base, { type: 'artifact/upsert', artifact: { ...base.artifacts[0], title: 'Replayed Lantern' } });
    const remote = workspaceReducer(base, { type: 'issue/transition', issueId: base.issues[0].id, status: 'resolved' });
    const result = replayIntents(
      [{ type: 'artifact/upsert', artifact: { ...base.artifacts[0], title: 'Replayed Lantern' } }],
      local,
      remote,
    );
    expect(result.errors).toHaveLength(0);
    expect(result.state.artifacts[0].title).toBe('Replayed Lantern');
    expect(result.state.issues.find((issue) => issue.id === base.issues[0].id)?.status).toBe('resolved');
  });

  it('replays placements against the stale tab layout without duplicating objects', () => {
    const base = seed();
    // Remote moves lantern (currently arrival index 0) into patterns.
    const remote = workspaceReducer(base, { type: 'placement/assign', artifactId: 'artifact-lantern', zoneId: 'zone-patterns' });
    // Stale local tab moved the sample book within patterns to the end.
    const local = workspaceReducer(base, { type: 'placement/assign', artifactId: 'artifact-sample-book', zoneId: 'zone-patterns', index: 2 });
    const result = replayIntents(
      [{ type: 'placement/assign', artifactId: 'artifact-sample-book', zoneId: 'zone-patterns', index: 2 }],
      local,
      remote,
    );
    expect(result.errors).toHaveLength(0);
    const patterns = result.state.zones.find((zone) => zone.id === 'zone-patterns')!;
    expect(new Set(patterns.artifactIds).size).toBe(patterns.artifactIds.length);
    expect(patterns.artifactIds).toContain('artifact-sample-book');
    expect(patterns.artifactIds).toContain('artifact-lantern');
  });

  it('reports a duplicated accession created by the two tabs adding separate objects as a replay error', () => {
    const base = seed();
    const template = base.artifacts[0];
    const now = new Date().toISOString();
    const localObject: Artifact = { ...template, id: 'artifact-local-new', title: 'Local new object', accessionId: 'AF-DUP-001', createdAt: now, updatedAt: now };
    const remoteObject: Artifact = { ...template, id: 'artifact-remote-new', title: 'Remote new object', accessionId: 'AF-DUP-001', createdAt: now, updatedAt: now };
    const local = workspaceReducer(base, { type: 'artifact/upsert', artifact: localObject });
    const remote = workspaceReducer(base, { type: 'artifact/upsert', artifact: remoteObject });
    const result = replayIntents(
      [{ type: 'artifact/upsert', artifact: localObject }],
      local,
      remote,
    );
    expect(result.errors.some((error) => error.includes('used by more than one object'))).toBe(true);
  });
});
