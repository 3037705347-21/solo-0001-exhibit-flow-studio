import { describe, expect, it } from 'vitest';
import type { WorkspaceState } from '../domain/models';
import { migrateWorkspace } from './migrations';
import { workspaceReducer } from './reducer';
import { createSeedWorkspace } from './seed';

function zoneVersion(state: WorkspaceState, zoneId: string): number {
  const zone = state.zones.find((candidate) => candidate.id === zoneId);
  if (!zone) throw new Error(`Unknown zone ${zoneId}`);
  return zone.version;
}

function zoneOrder(state: WorkspaceState, zoneId: string): string[] {
  const zone = state.zones.find((candidate) => candidate.id === zoneId);
  if (!zone) throw new Error(`Unknown zone ${zoneId}`);
  return zone.artifactIds;
}

describe('placement/reorder compare-and-swap', () => {
  it('commits the resolved order and bumps the zone version', () => {
    const state = createSeedWorkspace();
    const version = zoneVersion(state, 'zone-patterns');
    const next = workspaceReducer(state, {
      type: 'placement/reorder',
      zoneId: 'zone-patterns',
      artifactId: 'artifact-radio',
      expectedVersion: version,
      nextOrder: ['artifact-radio', 'artifact-sample-book'],
    });
    expect(zoneOrder(next, 'zone-patterns')).toEqual(['artifact-radio', 'artifact-sample-book']);
    expect(zoneVersion(next, 'zone-patterns')).toBe(version + 1);
    expect(next.lastSavedAt).not.toBe(state.lastSavedAt);
  });

  it('rejects a reorder based on a stale version without touching the zone', () => {
    // Simulate an external tab committing first: the zone is now at version+1.
    const external = workspaceReducer(createSeedWorkspace(), {
      type: 'placement/reorder',
      zoneId: 'zone-patterns',
      artifactId: 'artifact-radio',
      expectedVersion: 1,
      nextOrder: ['artifact-radio', 'artifact-sample-book'],
    });
    const stale = workspaceReducer(external, {
      type: 'placement/reorder',
      zoneId: 'zone-patterns',
      artifactId: 'artifact-radio',
      expectedVersion: 1,
      nextOrder: ['artifact-sample-book', 'artifact-radio'],
    });
    expect(stale).toBe(external);
    expect(zoneOrder(stale, 'zone-patterns')).toEqual(['artifact-radio', 'artifact-sample-book']);
  });

  it('rejects orders that would lose, duplicate, or introduce objects', () => {
    const state = createSeedWorkspace();
    const version = zoneVersion(state, 'zone-patterns');
    const attempts: string[][] = [
      ['artifact-radio'], // loses an object
      ['artifact-radio', 'artifact-sample-book', 'artifact-radio'], // duplicates
      ['artifact-radio', 'artifact-press'], // foreign id from another zone
      ['artifact-radio', 'artifact-unknown'], // unknown id
    ];
    for (const nextOrder of attempts) {
      const next = workspaceReducer(state, {
        type: 'placement/reorder',
        zoneId: 'zone-patterns',
        artifactId: 'artifact-radio',
        expectedVersion: version,
        nextOrder,
      });
      expect(next).toBe(state);
      expect(zoneOrder(state, 'zone-patterns')).toEqual(['artifact-sample-book', 'artifact-radio']);
    }
  });

  it('returns the same state for a no-op order and keeps the version', () => {
    const state = createSeedWorkspace();
    const next = workspaceReducer(state, {
      type: 'placement/reorder',
      zoneId: 'zone-patterns',
      artifactId: 'artifact-radio',
      expectedVersion: zoneVersion(state, 'zone-patterns'),
      nextOrder: ['artifact-sample-book', 'artifact-radio'],
    });
    expect(next).toBe(state);
  });

  it('ignores unknown zones', () => {
    const state = createSeedWorkspace();
    const next = workspaceReducer(state, {
      type: 'placement/reorder',
      zoneId: 'zone-missing',
      artifactId: 'artifact-radio',
      expectedVersion: 1,
      nextOrder: [],
    });
    expect(next).toBe(state);
  });
});

describe('zone version bumps', () => {
  it('bumps the target zone on assign and the source zone when moving between zones', () => {
    const state = createSeedWorkspace();
    const assigned = workspaceReducer(state, { type: 'placement/assign', artifactId: 'artifact-gloves', zoneId: 'zone-arrival' });
    expect(zoneVersion(assigned, 'zone-arrival')).toBe(zoneVersion(state, 'zone-arrival') + 1);
    expect(zoneVersion(assigned, 'zone-patterns')).toBe(zoneVersion(state, 'zone-patterns'));

    const moved = workspaceReducer(assigned, { type: 'placement/assign', artifactId: 'artifact-gloves', zoneId: 'zone-after' });
    expect(zoneVersion(moved, 'zone-arrival')).toBe(zoneVersion(assigned, 'zone-arrival') + 1);
    expect(zoneVersion(moved, 'zone-after')).toBe(zoneVersion(assigned, 'zone-after') + 1);
  });

  it('bumps only the containing zone on placement remove', () => {
    const state = createSeedWorkspace();
    const next = workspaceReducer(state, { type: 'placement/remove', artifactId: 'artifact-radio' });
    expect(zoneVersion(next, 'zone-patterns')).toBe(zoneVersion(state, 'zone-patterns') + 1);
    expect(zoneVersion(next, 'zone-arrival')).toBe(zoneVersion(state, 'zone-arrival'));
  });

  it('bumps the containing zone when an artifact is removed from the collection', () => {
    const state = createSeedWorkspace();
    const next = workspaceReducer(state, { type: 'artifact/remove', artifactId: 'artifact-quilt' });
    expect(zoneVersion(next, 'zone-common')).toBe(zoneVersion(state, 'zone-common') + 1);
    expect(zoneVersion(next, 'zone-after')).toBe(zoneVersion(state, 'zone-after'));
  });
});

describe('workspace restore and external sync', () => {
  it('adopts restored and external states verbatim', () => {
    const state = createSeedWorkspace();
    const reordered = workspaceReducer(state, {
      type: 'placement/reorder',
      zoneId: 'zone-after',
      artifactId: 'artifact-tape',
      expectedVersion: zoneVersion(state, 'zone-after'),
      nextOrder: ['artifact-tape', 'artifact-bowl'],
    });
    const restored = workspaceReducer(reordered, { type: 'workspace/restore', state });
    expect(restored).toBe(state);
    const external = workspaceReducer(state, { type: 'workspace/external', state: reordered });
    expect(external).toBe(reordered);
  });
});

describe('migration', () => {
  it('defaults missing zone versions and preserves existing ones', () => {
    const state = createSeedWorkspace();
    const legacy = JSON.parse(JSON.stringify(state)) as { zones: Array<{ version?: number }> };
    delete legacy.zones[0].version;
    legacy.zones[1].version = 7;
    const migrated = migrateWorkspace(legacy);
    expect(migrated).not.toBeNull();
    expect(migrated?.zones[0].version).toBe(1);
    expect(migrated?.zones[1].version).toBe(7);
  });
});
