import { describe, expect, it } from 'vitest';
import { migrateWorkspace, validateReferences } from './migrations';
import { createSeedWorkspace } from './seed';

describe('migrateWorkspace', () => {
  it('repairs a legacy project record while preserving every other module', () => {
    const seed = createSeedWorkspace();
    const legacy = {
      version: 1,
      project: {
        id: seed.project.id,
        title: seed.project.title,
        venue: seed.project.venue,
        audience: seed.project.audience,
        openingDate: '2027-13-99',
        stage: 'published',
      },
      artifacts: seed.artifacts,
      zones: seed.zones.map((zone) => ({ ...zone, sequence: undefined as unknown as number })),
      issues: seed.issues,
      preferences: seed.preferences,
    };

    const migrated = migrateWorkspace(legacy);
    expect(migrated).not.toBeNull();
    const state = validateReferences(migrated!);

    expect(state.project.openingDate).toBe('');
    expect(state.project.stage).toBe('draft');
    expect(state.artifacts).toBe(seed.artifacts);
    expect(state.preferences).toBe(seed.preferences);
    // Findings survive migration intact apart from the standard reference normalization the app always applies.
    expect(state.issues).toEqual(validateReferences(seed).issues);
    // Legacy zones without a sequence are indexed without modifying their contents.
    expect(state.zones.map((zone) => zone.sequence)).toEqual(seed.zones.map((_, index) => index));
    expect(state.zones.map((zone) => zone.artifactIds)).toEqual(seed.zones.map((zone) => zone.artifactIds));
  });
});
