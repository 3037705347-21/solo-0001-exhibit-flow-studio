import { describe, expect, it } from 'vitest';
import { loadWorkspace } from './persistence';
import { createSeedWorkspace } from './seed';
import { memoryStorage } from './testStorage';

describe('workspace persistence recovery', () => {
  it('falls back to seed data when stored JSON cannot be parsed', () => {
    const storage = memoryStorage({ 'exhibit-flow.workspace.v1': '{not valid json' });
    const loaded = loadWorkspace(storage);
    const seed = createSeedWorkspace();
    expect(loaded.project.title).toBe(seed.project.title);
    expect(loaded.artifacts).toHaveLength(seed.artifacts.length);
  });

  it('falls back to seed data for an unrecognized old structure', () => {
    const storage = memoryStorage({
      'exhibit-flow.workspace.v1': JSON.stringify({ schema: 'ancient', objects: [] }),
    });
    const loaded = loadWorkspace(storage);
    expect(loaded.version).toBe(1);
    expect(loaded.project.id).toBe(createSeedWorkspace().project.id);
  });

  it('falls back when a required collection is missing or the wrong shape', () => {
    const missingIssues = { ...createSeedWorkspace(), issues: undefined };
    const storage = memoryStorage({
      'exhibit-flow.workspace.v1': JSON.stringify(missingIssues),
    });
    const loaded = loadWorkspace(storage);
    expect(loaded.issues).toHaveLength(createSeedWorkspace().issues.length);
  });

  it('migrates a legacy workspace without zone sequence numbers', () => {
    const seed = createSeedWorkspace();
    const legacyZones = seed.zones.map(({ sequence: _sequence, ...zone }) => {
      void _sequence;
      return zone;
    });
    const legacy = {
      // Older saves did not carry a version field at all.
      project: seed.project,
      artifacts: seed.artifacts,
      zones: legacyZones,
      issues: seed.issues,
      preferences: seed.preferences,
    };
    const storage = memoryStorage({ 'exhibit-flow.workspace.v1': JSON.stringify(legacy) });

    const loaded = loadWorkspace(storage);
    expect(loaded.version).toBe(1);
    expect(loaded.zones.map((zone) => zone.sequence)).toEqual([0, 1, 2, 3]);
    expect(loaded.zones[1].name).toBe(seed.zones[1].name);
    expect(loaded.artifacts).toHaveLength(seed.artifacts.length);
  });

  it('strips dangling zone and finding references to deleted artifacts and zones', () => {
    const seed = createSeedWorkspace();
    const damaged = structuredClone(seed);
    // Reference an artifact that no longer exists...
    damaged.zones[0].artifactIds = ['artifact-ghost', ...damaged.zones[0].artifactIds];
    // ...and findings pointing at vanished entities.
    damaged.issues.push({
      id: 'issue-ghosts',
      title: 'Stale links',
      description: 'This finding points at records that have since been removed.',
      severity: 'warning',
      status: 'open',
      zoneId: 'zone-demolished',
      artifactId: 'artifact-ghost',
      owner: 'Archive job',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
    const storage = memoryStorage({ 'exhibit-flow.workspace.v1': JSON.stringify(damaged) });

    const loaded = loadWorkspace(storage);
    expect(loaded.zones[0].artifactIds).not.toContain('artifact-ghost');
    const repaired = loaded.issues.find((issue) => issue.id === 'issue-ghosts')!;
    expect(repaired.zoneId).toBeUndefined();
    expect(repaired.artifactId).toBeUndefined();
    // Valid links survive the cleanup.
    const intact = loaded.issues.find((issue) => issue.id === 'issue-audio-transcript')!;
    expect(intact.zoneId).toBe('zone-after');
    expect(intact.artifactId).toBe('artifact-tape');
  });
});
