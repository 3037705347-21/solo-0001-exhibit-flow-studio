import { describe, expect, it } from 'vitest';
import { migrateWorkspace, sanitizeCollectionViews } from './migrations';
import { createSeedWorkspace } from './seed';

const LEGACY_STATE = {
  version: 1,
  project: createSeedWorkspace().project,
  artifacts: createSeedWorkspace().artifacts,
  zones: createSeedWorkspace().zones,
  issues: createSeedWorkspace().issues,
  preferences: createSeedWorkspace().preferences,
  lastSavedAt: '2026-09-01T14:30:00.000Z',
};

describe('workspace migration for saved views', () => {
  it('adds an empty collectionViews array to workspaces saved before the feature existed', () => {
    const migrated = migrateWorkspace(LEGACY_STATE);
    expect(migrated).not.toBeNull();
    expect(migrated?.collectionViews).toEqual([]);
  });

  it('recovers well-formed live and frozen views and drops malformed ones', () => {
    const goodLive = {
      id: 'view-live',
      name: 'Live',
      kind: 'live',
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:00:00.000Z',
      ruleVersions: [{
        version: 1,
        rules: { query: 'lantern', roles: [], sensitivities: [], keyOnly: false },
        memberIds: ['artifact-lantern'],
        basis: 'query “lantern”',
        createdAt: '2026-09-01T10:00:00.000Z',
      }],
    };
    const goodFrozen = {
      id: 'view-frozen',
      name: 'Frozen',
      kind: 'frozen',
      createdAt: '2026-09-02T10:00:00.000Z',
      updatedAt: '2026-09-02T10:00:00.000Z',
      ruleVersions: [{
        version: 1,
        rules: { query: '', roles: ['reflection'], sensitivities: [], keyOnly: false },
        memberIds: ['artifact-bowl'],
        basis: '1 role filter',
        createdAt: '2026-09-02T10:00:00.000Z',
      }],
      frozenMembers: [{
        artifactId: 'artifact-bowl',
        accessionId: 'AF-1987-064',
        title: 'Mended Serving Bowl',
        narrativeRole: 'reflection',
        sensitivity: 'fragile',
        isKeyObject: false,
      }],
    };
    const badKind = { ...goodLive, id: 'view-bad-kind', kind: 'mystery' };
    const badRules = {
      ...goodLive,
      id: 'view-bad-rules',
      ruleVersions: [{ ...goodLive.ruleVersions[0], rules: { query: 4 } }],
    };
    // A missing member record is corrupted and dropped...
    const frozenWithoutRecord = { ...goodFrozen, id: 'view-no-record' };
    delete (frozenWithoutRecord as Partial<typeof frozenWithoutRecord>).frozenMembers;
    // ...but a frozen list issued with zero matching members is legitimate and retained.
    const emptyFrozen = { ...goodFrozen, id: 'view-empty-frozen', frozenMembers: [] };
    const views = sanitizeCollectionViews([goodLive, goodFrozen, badKind, badRules, frozenWithoutRecord, emptyFrozen, { nope: true }]);
    expect(views.map((view) => view.id)).toEqual(['view-live', 'view-frozen', 'view-empty-frozen']);
    expect(views[1].kind).toBe('frozen');
    expect(views[1].frozenMembers?.[0].accessionId).toBe('AF-1987-064');
    expect(views[2].kind).toBe('frozen');
    expect(views[2].frozenMembers).toEqual([]);
  });

  it('persists a frozen list issued while no objects matched through a full migration', () => {
    const emptyFrozen = {
      id: 'view-empty',
      name: 'Empty issue',
      kind: 'frozen',
      createdAt: '2026-09-02T10:00:00.000Z',
      updatedAt: '2026-09-02T10:00:00.000Z',
      ruleVersions: [{
        version: 1,
        rules: { query: 'definitely-no-such-object', roles: [], sensitivities: [], keyOnly: false },
        memberIds: [],
        basis: 'query “definitely-no-such-object”',
        createdAt: '2026-09-02T10:00:00.000Z',
      }],
      frozenMembers: [],
    };
    const migrated = migrateWorkspace({ ...LEGACY_STATE, collectionViews: [emptyFrozen] });
    expect(migrated?.collectionViews).toHaveLength(1);
    expect(migrated?.collectionViews[0].frozenMembers).toEqual([]);
    expect(migrated?.collectionViews[0].ruleVersions[0].memberIds).toEqual([]);
  });

  it('preserves frozen member references even when the referenced artifact no longer exists', () => {
    const frozenWithGhost = {
      id: 'view-ghost',
      name: 'Ghost list',
      kind: 'frozen',
      createdAt: '2026-09-02T10:00:00.000Z',
      updatedAt: '2026-09-02T10:00:00.000Z',
      ruleVersions: [{
        version: 1,
        rules: { query: '', roles: [], sensitivities: [], keyOnly: false },
        memberIds: ['artifact-deleted'],
        basis: 'all collection objects',
        createdAt: '2026-09-02T10:00:00.000Z',
      }],
      frozenMembers: [{
        artifactId: 'artifact-deleted',
        accessionId: 'AF-1899-001',
        title: 'Long Gone Object',
        narrativeRole: 'context',
        sensitivity: 'standard',
        isKeyObject: false,
      }],
    };
    const migrated = migrateWorkspace({ ...LEGACY_STATE, collectionViews: [frozenWithGhost] });
    expect(migrated?.collectionViews[0].frozenMembers?.[0].artifactId).toBe('artifact-deleted');
  });
});
