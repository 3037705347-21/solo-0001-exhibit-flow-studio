import { describe, expect, it } from 'vitest';
import { emptyZoneDraft, validateZoneDraft, zoneToDraft } from './zoneValidation';
import { createSeedWorkspace } from '../state/seed';
import { planZoneDelete } from './zoneRemoval';

describe('validateZoneDraft', () => {
  const zones = createSeedWorkspace().zones;

  it('accepts a complete new zone draft', () => {
    expect(validateZoneDraft(emptyZoneDraftWith({ name: 'Study Gallery' }), zones)).toEqual([]);
  });

  it('requires a name', () => {
    const errors = validateZoneDraft(emptyZoneDraftWith({ name: '   ' }), zones);
    expect(errors).toContainEqual(expect.objectContaining({ field: 'name' }));
  });

  it('rejects a duplicate zone name regardless of casing', () => {
    const errors = validateZoneDraft(
      emptyZoneDraftWith({ name: 'afterlives' }),
      zones,
    );
    expect(errors).toContainEqual(expect.objectContaining({ field: 'name', message: expect.stringContaining('already exists') }));
  });

  it('allows an existing zone to keep its own name while editing', () => {
    const afterlives = zones.find((zone) => zone.id === 'zone-after')!;
    expect(validateZoneDraft(zoneToDraft(afterlives), zones, afterlives.id)).toEqual([]);
  });

  it('rejects zero, negative, and fractional capacity values', () => {
    expect(validateZoneDraft(emptyZoneDraftWith({ capacityMinutes: '0' }), zones).map((error) => error.field)).toContain('capacityMinutes');
    expect(validateZoneDraft(emptyZoneDraftWith({ capacityMinutes: '-4' }), zones).map((error) => error.field)).toContain('capacityMinutes');
    expect(validateZoneDraft(emptyZoneDraftWith({ maxObjects: '2.5' }), zones).map((error) => error.field)).toContain('maxObjects');
  });

  it('rejects an invalid color', () => {
    expect(validateZoneDraft(emptyZoneDraftWith({ color: 'red' }), zones).map((error) => error.field)).toContain('color');
  });
});

describe('planZoneDelete', () => {
  it('returns null for an unknown zone', () => {
    expect(planZoneDelete(createSeedWorkspace(), 'zone-nope')).toBeNull();
  });

  it('groups placed objects, zone-level findings, and object findings', () => {
    const state = createSeedWorkspace();
    const impact = planZoneDelete(state, 'zone-after');
    expect(impact).not.toBeNull();
    expect(impact!.objects.map((artifact) => artifact.id)).toEqual(['artifact-bowl', 'artifact-tape']);
    expect(impact!.zoneFindings.map((issue) => issue.id)).toEqual([]);
    // The oral history issue is linked to both the zone and the tape object.
    expect(impact!.objectFindings.map((issue) => issue.id)).toEqual(['issue-audio-transcript']);

    const arrival = planZoneDelete(state, 'zone-arrival');
    expect(arrival!.objects.map((artifact) => artifact.id)).toEqual(['artifact-lantern']);
    expect(arrival!.zoneFindings.map((issue) => issue.id)).toEqual(['issue-entry-copy']);
  });
});

function emptyZoneDraftWith(overrides: Partial<typeof emptyZoneDraft>) {
  return { ...emptyZoneDraft, ...overrides };
}
