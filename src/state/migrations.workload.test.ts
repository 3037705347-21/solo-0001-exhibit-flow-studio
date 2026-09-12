import { describe, expect, it } from 'vitest';
import { migrateWorkspace } from './migrations';
import { createSeedWorkspace } from './seed';

describe('migrateWorkspace workload fields', () => {
  it('backfills issue versions and the assignment log for legacy workspaces', () => {
    const seed = createSeedWorkspace();
    const legacy = {
      version: 1,
      project: seed.project,
      artifacts: seed.artifacts,
      zones: seed.zones,
      issues: seed.issues.map(({ version: _version, ...issue }) => issue) as never,
      preferences: seed.preferences,
      lastSavedAt: seed.lastSavedAt,
    };
    const migrated = migrateWorkspace(legacy);
    expect(migrated).not.toBeNull();
    expect(migrated!.issues.every((issue) => issue.version === 0)).toBe(true);
    expect(migrated!.assignmentLog).toEqual([]);
  });

  it('preserves versions already stored', () => {
    const seed = createSeedWorkspace();
    const migrated = migrateWorkspace({ ...seed });
    expect(migrated!.issues.map((issue) => issue.version)).toEqual(seed.issues.map((issue) => issue.version));
  });
});
