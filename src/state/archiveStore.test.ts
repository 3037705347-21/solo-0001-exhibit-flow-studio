import { describe, expect, it } from 'vitest';
import type { ArchiveEntry } from '../domain/archive';
import {
  ARCHIVE_KEY,
  loadArchiveEntries,
  loadArchiveSort,
  saveArchiveEntries,
  saveArchiveSort,
} from './archiveStore';
import type { Snapshot } from '../domain/models';

const snapshot: Snapshot = {
  schemaVersion: 1,
  generatedAt: '2026-09-01T10:00:00.000Z',
  project: {
    id: 'project-afterlight',
    title: 'Afterlight',
    venue: 'North Hall',
    audience: 'All',
    openingDate: '2027-03-18',
    stage: 'ready',
  },
  summary: { artifactCount: 1, zoneCount: 1, visitMinutes: 10, readinessScore: 90 },
  zones: [{
    id: 'zone-1', name: 'Zone', shortLabel: 'Z', thesis: 't', capacityMinutes: 60, maxObjects: 5,
    lowLight: false, hasSeating: false, color: '#000', sequence: 0, artifactIds: [], artifacts: [],
  }],
  unresolvedIssues: [],
};

function makeEntry(overrides: Partial<ArchiveEntry> = {}): ArchiveEntry {
  return {
    id: 'project-afterlight:hash1234',
    planId: 'project-afterlight',
    planKey: 'project-afterlight',
    projectTitle: 'Afterlight',
    venue: 'North Hall',
    contentHash: 'hash1234',
    generatedAt: '2026-09-01T10:00:00.000Z',
    importedAt: '2026-09-02T10:00:00.000Z',
    lastImportedAt: '2026-09-02T10:00:00.000Z',
    importCount: 1,
    importFileName: 'snapshot.json',
    version: 1,
    snapshot,
    ...overrides,
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } as unknown as Storage,
    values,
  };
}

describe('archive persistence', () => {
  it('round trips archive entries through a dedicated storage key', () => {
    const { storage, values } = memoryStorage();
    saveArchiveEntries([makeEntry()], storage);
    expect(values.has(ARCHIVE_KEY)).toBe(true);
    // The archive never shares the live workspace key.
    expect(values.has('exhibit-flow.workspace.v1')).toBe(false);
    const loaded = loadArchiveEntries(storage);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('project-afterlight:hash1234');
    expect(loaded[0].snapshot.project.title).toBe('Afterlight');
  });

  it('falls back to an empty archive for malformed or shaped-wrong storage', () => {
    expect(loadArchiveEntries({ getItem: () => '{bad json' } as unknown as Storage)).toEqual([]);
    expect(loadArchiveEntries({ getItem: () => '{"not":"array"}' } as unknown as Storage)).toEqual([]);
    expect(loadArchiveEntries({ getItem: () => 'null' } as unknown as Storage)).toEqual([]);
  });

  it('drops corrupt records but keeps the valid ones', () => {
    const { storage } = memoryStorage();
    const mixed = [
      makeEntry(),
      makeEntry({ id: 'project-afterlight:other' }),
      { id: 'missing-fields', planId: 'x' },
    ];
    storage.setItem(ARCHIVE_KEY, JSON.stringify(mixed));
    expect(loadArchiveEntries(storage)).toHaveLength(2);
  });

  it('persists and validates the sort preference', () => {
    const { storage } = memoryStorage();
    saveArchiveSort('title', storage);
    expect(loadArchiveSort(storage)).toBe('title');
    storage.setItem('exhibit-flow.plan-archive-ui.v1', JSON.stringify({ sort: 'bogus' }));
    expect(loadArchiveSort(storage)).toBe('recent');
  });
});
