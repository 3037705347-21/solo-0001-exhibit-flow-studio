import { describe, expect, it } from 'vitest';
import type { WorkspaceState } from '../domain/models';
import type { WorkspaceAction } from './actions';
import { workspaceReducer } from './reducer';
import { createSeedWorkspace } from './seed';

function reduce(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  return workspaceReducer(state, action);
}

describe('project/settings reducer command', () => {
  it('updates only the four project metadata fields', () => {
    const seed = createSeedWorkspace();
    const next = reduce(seed, {
      type: 'project/settings',
      settings: { title: 'Renamed Show', venue: '', audience: 'School groups', openingDate: '' },
    });

    expect(next.project).toMatchObject({
      id: seed.project.id,
      title: 'Renamed Show',
      venue: '',
      audience: 'School groups',
      openingDate: '',
      stage: seed.project.stage,
    });
    // Objects, zones, findings, and preferences are passed through untouched.
    expect(next.artifacts).toBe(seed.artifacts);
    expect(next.zones).toBe(seed.zones);
    expect(next.issues).toBe(seed.issues);
    expect(next.preferences).toBe(seed.preferences);
    expect(next.lastSavedAt).toBeTruthy();
  });

  it('does not regress a ready project when metadata is edited', () => {
    const ready: WorkspaceState = {
      ...createSeedWorkspace(),
      project: { ...createSeedWorkspace().project, stage: 'ready' },
    };
    const next = reduce(ready, {
      type: 'project/settings',
      settings: { title: ready.project.title, venue: ready.project.venue, audience: ready.project.audience, openingDate: ready.project.openingDate },
    });
    expect(next.project.stage).toBe('ready');
  });

  it('cancellation-style no-op dispatch leaves other modules identical', () => {
    const seed = createSeedWorkspace();
    const next = reduce(seed, {
      type: 'project/settings',
      settings: { title: seed.project.title, venue: seed.project.venue, audience: seed.project.audience, openingDate: seed.project.openingDate },
    });
    expect(next.artifacts).toBe(seed.artifacts);
    expect(next.zones).toBe(seed.zones);
    expect(next.issues).toBe(seed.issues);
    expect(next.preferences).toBe(seed.preferences);
  });
});
