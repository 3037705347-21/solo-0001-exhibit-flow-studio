import { describe, expect, it } from 'vitest';
import { migrateWorkspace, normalizeZone, validateReferences } from './migrations';
import { createSeedWorkspace } from './seed';

describe('migrateWorkspace zone compatibility', () => {
  it('loads the current seed shape unchanged', () => {
    const seed = createSeedWorkspace();
    const migrated = migrateWorkspace(JSON.parse(JSON.stringify(seed)));
    expect(migrated!.zones).toHaveLength(4);
    expect(migrated!.zones.map((zone) => zone.sequence)).toEqual([0, 1, 2, 3]);
  });

  it('fills missing sequence numbers by array position', () => {
    const seed = createSeedWorkspace();
    const legacy = JSON.parse(JSON.stringify(seed));
    legacy.zones.forEach((zone: { sequence?: number }) => { delete zone.sequence; });
    const migrated = migrateWorkspace(legacy)!;
    expect(migrated.zones.map((zone) => zone.sequence)).toEqual([0, 1, 2, 3]);
  });

  it('repairs partially corrupted zone records from older data', () => {
    const legacyZone = normalizeZone({
      id: 'zone-old',
      name: '',
      capacityMinutes: -5,
      // maxObjects, color, artifactIds, shortLabel, thesis missing
    } as never, 0);
    expect(legacyZone.name).toBe('Zone 1');
    expect(legacyZone.capacityMinutes).toBe(15);
    expect(legacyZone.maxObjects).toBe(4);
    expect(legacyZone.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(legacyZone.artifactIds).toEqual([]);
    expect(legacyZone.lowLight).toBe(false);
    expect(legacyZone.hasSeating).toBe(false);
  });

  it('rejects a workspace whose zones lack ids', () => {
    const seed = createSeedWorkspace();
    const legacy = JSON.parse(JSON.stringify(seed));
    delete legacy.zones[1].id;
    expect(migrateWorkspace(legacy)).toBeNull();
  });

  it('preserves detached findings and unknown issue fields through migration', () => {
    const seed = createSeedWorkspace();
    const legacy = JSON.parse(JSON.stringify(seed));
    legacy.issues[0].zoneId = 'zone-gone';
    legacy.issues[0].detachedFromZone = 'Removed Room';
    const migrated = validateReferences(migrateWorkspace(legacy)!);
    expect(migrated.issues[0].zoneId).toBeUndefined();
    expect(migrated.issues[0].detachedFromZone).toBe('Removed Room');
  });
});
