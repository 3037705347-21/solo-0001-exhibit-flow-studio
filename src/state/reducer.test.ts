import { describe, expect, it } from 'vitest';
import { workspaceReducer } from './reducer';
import type { WorkspaceAction } from './actions';
import { createSeedWorkspace } from './seed';
import type { Artifact, ReviewIssue, WorkspaceState } from '../domain/models';

function seedWith(mutate?: (state: WorkspaceState) => void): WorkspaceState {
  const state: WorkspaceState = structuredClone(createSeedWorkspace());
  mutate?.(state);
  return state;
}

function dispatch(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  return workspaceReducer(state, action);
}

describe('workspace reducer command chains', () => {
  it('moves an artifact between zones without leaving a duplicate and inserts it at the requested position', () => {
    let state = seedWith();
    const zone = (id: string) => state.zones.find((candidate) => candidate.id === id)!;

    // Place the unplaced gloves at the front of the arrival zone first.
    state = dispatch(state, { type: 'placement/assign', artifactId: 'artifact-gloves', zoneId: 'zone-arrival', index: 0 });
    expect(zone('zone-arrival').artifactIds).toEqual(['artifact-gloves', 'artifact-lantern']);

    // Moving it to a different zone removes it from the source, appends it in the target, and never duplicates it.
    state = dispatch(state, { type: 'placement/assign', artifactId: 'artifact-gloves', zoneId: 'zone-after' });
    expect(zone('zone-arrival').artifactIds).toEqual(['artifact-lantern']);
    expect(zone('zone-after').artifactIds).toEqual(['artifact-bowl', 'artifact-tape', 'artifact-gloves']);
    const occurrences = state.zones.reduce(
      (count, current) => count + current.artifactIds.filter((id) => id === 'artifact-gloves').length,
      0,
    );
    expect(occurrences).toBe(1);
  });

  it('clamps an out of range placement index to the end of the target zone', () => {
    const state = dispatch(seedWith(), {
      type: 'placement/assign',
      artifactId: 'artifact-gloves',
      zoneId: 'zone-arrival',
      index: 99,
    });
    expect(state.zones.find((zone) => zone.id === 'zone-arrival')!.artifactIds).toEqual([
      'artifact-lantern',
      'artifact-gloves',
    ]);
  });

  it('removes an artifact from the collection, every zone, and its linked findings', () => {
    const state = dispatch(
      seedWith((seed) => {
        seed.issues.push({
          id: 'issue-lantern-note',
          title: 'Lantern mount review',
          description: 'Confirm the wall mount can hold the lantern during busy school visits.',
          severity: 'warning',
          status: 'open',
          zoneId: 'zone-arrival',
          artifactId: 'artifact-lantern',
          owner: 'Theo James',
          createdAt: '2026-09-02T09:00:00.000Z',
          updatedAt: '2026-09-02T09:00:00.000Z',
        });
      }),
      { type: 'artifact/remove', artifactId: 'artifact-lantern' },
    );

    expect(state.artifacts.some((artifact) => artifact.id === 'artifact-lantern')).toBe(false);
    expect(state.zones.every((zone) => !zone.artifactIds.includes('artifact-lantern'))).toBe(true);
    expect(state.issues.some((issue) => issue.artifactId === 'artifact-lantern')).toBe(false);
    // A zone-level finding without an artifact link is intentionally retained.
    expect(state.issues.some((issue) => issue.id === 'issue-entry-copy')).toBe(true);
  });

  it('rejects a finding status jump through the reducer and records a new timestamp on a legal move', () => {
    const issue: ReviewIssue = {
      id: 'issue-open',
      title: 'Fresh finding',
      description: 'A brand new finding that has not been picked up by anyone yet.',
      severity: 'critical',
      status: 'open',
      owner: 'Mara Chen',
      createdAt: '2026-09-01T08:00:00.000Z',
      updatedAt: '2026-09-01T08:00:00.000Z',
    };
    const state = seedWith((seed) => { seed.issues.push(issue); });

    expect(() => dispatch(state, { type: 'issue/transition', issueId: issue.id, status: 'resolved' })).toThrow();

    const moved = dispatch(state, {
      type: 'issue/transition',
      issueId: issue.id,
      status: 'in-progress',
      at: new Date('2026-09-05T10:00:00.000Z'),
    });
    const updated = moved.issues.find((candidate) => candidate.id === issue.id)!;
    expect(updated.status).toBe('in-progress');
    expect(updated.updatedAt).toBe('2026-09-05T10:00:00.000Z');
    expect(updated.updatedAt).not.toBe(issue.updatedAt);
  });

  it('returns a ready project to review for readiness-impacting commands', () => {
    const ready = seedWith((seed) => { seed.project.stage = 'ready'; });

    const artifactAction = dispatch(ready, {
      type: 'artifact/upsert',
      artifact: ready.artifacts[0] as Artifact,
    });
    expect(artifactAction.project.stage).toBe('review');

    const placementAction = dispatch(ready, {
      type: 'placement/assign',
      artifactId: 'artifact-gloves',
      zoneId: 'zone-arrival',
    });
    expect(placementAction.project.stage).toBe('review');

    const removeAction = dispatch(ready, { type: 'artifact/remove', artifactId: 'artifact-gloves' });
    expect(removeAction.project.stage).toBe('review');

    const issueAction = dispatch(ready, {
      type: 'issue/add',
      issue: {
        id: 'issue-new',
        title: 'New blocker',
        description: 'Something that must be resolved before the plan can ship.',
        severity: 'critical',
        status: 'open',
        owner: 'Mara Chen',
        createdAt: '2026-09-05T10:00:00.000Z',
        updatedAt: '2026-09-05T10:00:00.000Z',
      },
    });
    expect(issueAction.project.stage).toBe('review');
  });

  it('does not regress the stage for a preference-only update', () => {
    const ready = seedWith((seed) => { seed.project.stage = 'ready'; });
    const state = dispatch(ready, {
      type: 'preferences/update',
      preferences: { ...ready.preferences, pace: 'leisurely' },
    });
    expect(state.project.stage).toBe('ready');
  });
});
