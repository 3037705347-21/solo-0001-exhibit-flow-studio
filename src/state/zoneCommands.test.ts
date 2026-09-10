import { describe, expect, it } from 'vitest';
import { workspaceReducer } from './reducer';
import { createSeedWorkspace } from './seed';
import { getUnplacedArtifacts } from '../domain/journeyAnalysis';
import type { Zone } from '../domain/models';

function newZone(overrides: Partial<Zone> = {}): Zone {
  return {
    id: 'zone-test',
    name: 'Study Nook',
    shortLabel: 'Study',
    thesis: 'A quiet room for close looking.',
    capacityMinutes: 12,
    maxObjects: 2,
    lowLight: true,
    hasSeating: true,
    color: '#496786',
    sequence: 4,
    artifactIds: [],
    ...overrides,
  };
}

describe('zone reducer commands', () => {
  it('adds a new empty zone at the end of the sequence without touching placements', () => {
    const state = createSeedWorkspace();
    const next = workspaceReducer(state, { type: 'zone/upsert', zone: newZone() });
    expect(next.zones).toHaveLength(5);
    const added = next.zones.find((zone) => zone.id === 'zone-test')!;
    expect(added.sequence).toBe(4);
    expect(added.artifactIds).toEqual([]);
    expect(getUnplacedArtifacts(next.artifacts, next.zones)).toHaveLength(1);
  });

  it('editing capacity below current occupancy keeps objects but leaves the over-limit state visible', () => {
    const state = createSeedWorkspace();
    const patterns = state.zones.find((zone) => zone.id === 'zone-patterns')!;
    const edited: Zone = { ...patterns, maxObjects: 1 };
    const next = workspaceReducer(state, { type: 'zone/upsert', zone: edited });
    const updated = next.zones.find((zone) => zone.id === 'zone-patterns')!;
    expect(updated.maxObjects).toBe(1);
    expect(updated.artifactIds).toEqual(['artifact-sample-book', 'artifact-radio']);
  });

  it('reorders zones with adjacent swaps and normalizes sequences', () => {
    const state = createSeedWorkspace();
    const next = workspaceReducer(state, { type: 'zone/reorder', zoneId: 'zone-common', direction: -1 });
    const ordered = [...next.zones].sort((left, right) => left.sequence - right.sequence).map((zone) => zone.id);
    expect(ordered).toEqual(['zone-arrival', 'zone-common', 'zone-patterns', 'zone-after']);
    expect(next.zones.map((zone) => zone.sequence).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it('does nothing when moving the first zone earlier', () => {
    const state = createSeedWorkspace();
    const next = workspaceReducer(state, { type: 'zone/reorder', zoneId: 'zone-arrival', direction: -1 });
    expect(next.zones).toBe(state.zones);
  });

  it('deleting a non-empty zone returns objects to the unplaced queue and detaches zone findings', () => {
    const state = createSeedWorkspace();
    const next = workspaceReducer(state, { type: 'zone/remove', zoneId: 'zone-arrival' });
    expect(next.zones.map((zone) => zone.id)).not.toContain('zone-arrival');
    expect(getUnplacedArtifacts(next.artifacts, next.zones).map((artifact) => artifact.id)).toContain('artifact-lantern');
    // Sequences are compacted after removal.
    expect(next.zones.map((zone) => zone.sequence).sort((a, b) => a - b)).toEqual([0, 1, 2]);
    // The zone-level finding survives without a zone link and records its former zone.
    const entryCopy = next.issues.find((issue) => issue.id === 'issue-entry-copy')!;
    expect(entryCopy.zoneId).toBeUndefined();
    expect(entryCopy.detachedFromZone).toBe('Arrival / A Light Carried');
    // The finding linked to both the deleted zone and a surviving object keeps the object link.
    const quiltIssue = next.issues.find((issue) => issue.id === 'issue-quilt-light')!;
    expect(quiltIssue.zoneId).toBe('zone-common');
  });

  it('object-only findings keep their artifact link but lose the deleted zone link', () => {
    const state = createSeedWorkspace();
    // issue-audio-transcript links zone-after + artifact-tape
    const next = workspaceReducer(state, { type: 'zone/remove', zoneId: 'zone-after' });
    const audio = next.issues.find((issue) => issue.id === 'issue-audio-transcript')!;
    expect(audio.zoneId).toBeUndefined();
    expect(audio.artifactId).toBe('artifact-tape');
    expect(audio.detachedFromZone).toBeUndefined();
    // The tape is back in the unplaced queue.
    expect(getUnplacedArtifacts(next.artifacts, next.zones).map((artifact) => artifact.id)).toContain('artifact-tape');
  });

  it('structural zone changes regress a ready project', () => {
    const ready = { ...createSeedWorkspace(), project: { ...createSeedWorkspace().project, stage: 'ready' as const } };
    const next = workspaceReducer(ready, { type: 'zone/upsert', zone: newZone() });
    expect(next.project.stage).toBe('review');
  });
});
