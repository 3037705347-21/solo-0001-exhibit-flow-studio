import { describe, expect, it } from 'vitest';
import { createSeedWorkspace } from './seed';
import { migrateWorkspace } from './migrations';

describe('workspace migration for scenario records', () => {
  it('adds an empty scenarioRecords list to workspaces saved before comparisons existed', () => {
    const seed = createSeedWorkspace();
    const legacy = {
      version: 1,
      project: seed.project,
      artifacts: seed.artifacts,
      zones: seed.zones,
      issues: seed.issues,
      preferences: seed.preferences,
    };
    const migrated = migrateWorkspace(legacy);
    expect(migrated?.scenarioRecords).toEqual([]);
  });

  it('drops malformed or duplicated stored records but keeps valid ones', () => {
    const seed = createSeedWorkspace();
    const validRecord = {
      id: 'scenario-valid',
      name: 'Valid',
      input: { pace: 'balanced', groupSize: 5, accessibilityPriority: 50 },
      planVersion: 'abcd1234',
      planBasis: { artifactCount: 8, zoneCount: 4, placedCount: 6, totalDwellMinutes: 30 },
      projection: { durationMinutes: 40, comfortScore: 80, accessibilityScore: 80, narrativeScore: 90, pressureZoneIds: [], recommendations: ['ok'] },
      createdAt: '2026-09-01T10:00:00.000Z',
    };
    const migrated = migrateWorkspace({
      version: 1,
      project: seed.project,
      artifacts: seed.artifacts,
      zones: seed.zones,
      issues: seed.issues,
      preferences: seed.preferences,
      scenarioRecords: [
        validRecord,
        { id: 'scenario-broken', name: 'Missing fields' },
        validRecord,
        { ...validRecord, id: 'scenario-dup-name', name: 'VALID' },
      ],
    });
    expect(migrated?.scenarioRecords.map((record) => record.id)).toEqual(['scenario-valid']);
  });
});
