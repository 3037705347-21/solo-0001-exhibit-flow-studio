import { describe, expect, it } from 'vitest';
import {
  compareArtifacts,
  DEFAULT_COLLECTION_SORT,
  defaultDirectionForKey,
  normalizeCollectionSort,
  sortCollection,
  type CollectionSort,
} from './collectionSort';
import { collectionListFileName, serializeCollectionCsv } from './export';
import { filterCollection } from './filters';
import type { Artifact } from './models';
import { createSeedWorkspace } from '../state/seed';

let counter = 0;
function artifact(overrides: Partial<Artifact> = {}): Artifact {
  counter += 1;
  return {
    id: `artifact-test-${counter}`,
    accessionId: `AF-2026-${String(counter).padStart(3, '0')}`,
    title: `Test Object ${counter}`,
    maker: 'Test Maker',
    yearLabel: '2000',
    medium: 'Clay',
    origin: 'Test Origin',
    summary: 'A test object summary with enough length.',
    dimensions: { width: 10, height: 10, depth: 10, unit: 'cm' },
    dwellMinutes: 5,
    narrativeRole: 'context',
    sensitivity: 'standard',
    accessibilityNeed: 'none',
    isKeyObject: false,
    tags: [],
    color: '#000000',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const ids = (list: Artifact[]) => list.map((item) => item.id);

describe('sortCollection', () => {
  it('separates identical titles by accession ID, regardless of input order', () => {
    const a = artifact({ id: 'a', accessionId: 'AF-100', title: 'Shared Title' });
    const b = artifact({ id: 'b', accessionId: 'AF-101', title: 'Shared Title' });
    const c = artifact({ id: 'c', accessionId: 'AF-102', title: 'Shared Title' });
    expect(ids(sortCollection([c, a, b], { key: 'title', direction: 'asc' }))).toEqual(['a', 'b', 'c']);
    expect(ids(sortCollection([b, c, a], { key: 'title', direction: 'asc' }))).toEqual(['a', 'b', 'c']);
    // The explicit tie order is fixed: flipping direction does not reshuffle equal titles.
    expect(ids(sortCollection([c, a, b], { key: 'title', direction: 'desc' }))).toEqual(['a', 'b', 'c']);
  });

  it('separates identical dwell times by title, then accession ID, in both directions', () => {
    const zeta = artifact({ id: 'zeta', accessionId: 'AF-200', title: 'Zeta', dwellMinutes: 6 });
    const alpha = artifact({ id: 'alpha', accessionId: 'AF-201', title: 'Alpha', dwellMinutes: 6 });
    const middle = artifact({ id: 'middle', accessionId: 'AF-202', title: 'Middle', dwellMinutes: 6 });
    expect(ids(sortCollection([zeta, middle, alpha], { key: 'dwellMinutes', direction: 'asc' }))).toEqual(['alpha', 'middle', 'zeta']);
    expect(ids(sortCollection([zeta, middle, alpha], { key: 'dwellMinutes', direction: 'desc' }))).toEqual(['alpha', 'middle', 'zeta']);
  });

  it('sorts dwell time numerically with direction', () => {
    const short = artifact({ id: 'short', dwellMinutes: 2 });
    const long = artifact({ id: 'long', dwellMinutes: 9 });
    expect(ids(sortCollection([short, long], { key: 'dwellMinutes', direction: 'desc' }))).toEqual(['long', 'short']);
    expect(ids(sortCollection([long, short], { key: 'dwellMinutes', direction: 'asc' }))).toEqual(['short', 'long']);
  });

  it('orders by update time and separates equal timestamps by accession ID', () => {
    const older = artifact({ id: 'older', accessionId: 'AF-300', updatedAt: '2026-08-01T09:00:00.000Z' });
    const newer = artifact({ id: 'newer', accessionId: 'AF-301', updatedAt: '2026-09-01T09:00:00.000Z' });
    const tie = artifact({ id: 'tie', accessionId: 'AF-302', updatedAt: '2026-09-01T09:00:00.000Z' });
    expect(ids(sortCollection([tie, older, newer], { key: 'updatedAt', direction: 'desc' }))).toEqual(['newer', 'tie', 'older']);
    expect(ids(sortCollection([tie, older, newer], { key: 'updatedAt', direction: 'asc' }))).toEqual(['older', 'newer', 'tie']);
  });

  it('sorts narrative roles in story-arc order, then by title', () => {
    const reflection = artifact({ id: 'reflection', title: 'Alpha', narrativeRole: 'reflection' });
    const threshold = artifact({ id: 'threshold', title: 'Zeta', narrativeRole: 'threshold' });
    const turning = artifact({ id: 'turning', title: 'Turn', narrativeRole: 'turning-point' });
    const context = artifact({ id: 'context', title: 'Context', narrativeRole: 'context' });
    const sorted = sortCollection([reflection, turning, context, threshold], { key: 'narrativeRole', direction: 'asc' });
    expect(ids(sorted)).toEqual(['threshold', 'context', 'turning', 'reflection']);
  });

  it('defaults to added order based on createdAt', () => {
    const first = artifact({ id: 'first', createdAt: '2026-01-01T00:00:00.000Z' });
    const second = artifact({ id: 'second', createdAt: '2026-02-01T00:00:00.000Z' });
    expect(DEFAULT_COLLECTION_SORT).toEqual({ key: 'added', direction: 'asc' });
    expect(ids(sortCollection([second, first]))).toEqual(['first', 'second']);
  });

  it('produces the same total order for any input permutation', () => {
    const items = [
      artifact({ id: 'one', accessionId: 'AF-1', title: 'Beta', dwellMinutes: 4, updatedAt: '2026-08-02T00:00:00.000Z' }),
      artifact({ id: 'two', accessionId: 'AF-2', title: 'Alpha', dwellMinutes: 4, updatedAt: '2026-08-01T00:00:00.000Z' }),
      artifact({ id: 'three', accessionId: 'AF-3', title: 'Alpha', dwellMinutes: 7, updatedAt: '2026-08-03T00:00:00.000Z' }),
      artifact({ id: 'four', accessionId: 'AF-4', title: 'Gamma', dwellMinutes: 7, updatedAt: '2026-08-03T00:00:00.000Z' }),
    ];
    const sorts: CollectionSort[] = [
      { key: 'added', direction: 'asc' },
      { key: 'title', direction: 'asc' },
      { key: 'title', direction: 'desc' },
      { key: 'dwellMinutes', direction: 'asc' },
      { key: 'dwellMinutes', direction: 'desc' },
      { key: 'updatedAt', direction: 'asc' },
      { key: 'updatedAt', direction: 'desc' },
      { key: 'narrativeRole', direction: 'asc' },
    ];
    for (const sort of sorts) {
      const expected = ids(sortCollection(items, sort));
      expect(ids(sortCollection([...items].reverse(), sort))).toEqual(expected);
      expect(ids(sortCollection([items[2], items[0], items[3], items[1]], sort))).toEqual(expected);
    }
  });

  it('gives every pair of seed objects exactly one legal order under every rule', () => {
    const items = createSeedWorkspace().artifacts;
    const keys = ['added', 'title', 'dwellMinutes', 'updatedAt', 'narrativeRole'] as const;
    for (const key of keys) {
      for (const direction of ['asc', 'desc'] as const) {
        for (const left of items) {
          for (const right of items) {
            if (left === right) continue;
            const result = compareArtifacts(left, right, { key, direction });
            expect(result).not.toBe(0);
            expect(compareArtifacts(right, left, { key, direction })).toBe(-result);
          }
        }
      }
    }
  });

  it('never mutates the input array, the artifacts, or their timestamps', () => {
    const items = [
      artifact({ id: 'keep-1', title: 'Bravo', updatedAt: '2026-08-04T00:00:00.000Z' }),
      artifact({ id: 'keep-2', title: 'Alpha', updatedAt: '2026-08-04T00:00:00.000Z' }),
    ];
    const before = JSON.stringify(items);
    const sorted = sortCollection(items, { key: 'title', direction: 'asc' });
    expect(ids(sorted)).toEqual(['keep-2', 'keep-1']);
    expect(ids(items)).toEqual(['keep-1', 'keep-2']);
    expect(JSON.stringify(items)).toBe(before);
  });

  it('keeps relative order stable while search and filters toggle', () => {
    const seed = createSeedWorkspace().artifacts;
    const sort: CollectionSort = { key: 'title', direction: 'asc' };
    const fullOrder = sortCollection(seed, sort);

    const roleOnly = filterCollection(fullOrder, { query: '', roles: ['reflection'], sensitivities: [], keyOnly: false });
    expect(roleOnly.length).toBeGreaterThan(0);
    expect(roleOnly).toEqual(fullOrder.filter((item) => roleOnly.includes(item)));

    const queried = filterCollection(fullOrder, { query: 'radio', roles: [], sensitivities: [], keyOnly: false });
    expect(queried.length).toBeGreaterThan(0);
    expect(queried).toEqual(fullOrder.filter((item) => queried.includes(item)));

    const sensitivityOnly = filterCollection(fullOrder, { query: '', roles: [], sensitivities: ['low-light'], keyOnly: false });
    expect(sensitivityOnly).toEqual(fullOrder.filter((item) => sensitivityOnly.includes(item)));

    // Clearing every filter restores the identical order.
    const restored = filterCollection(sortCollection(seed, sort), { query: '', roles: [], sensitivities: [], keyOnly: false });
    expect(ids(restored)).toEqual(ids(fullOrder));
  });
});

describe('defaultDirectionForKey', () => {
  it('picks explainable default directions per key', () => {
    expect(defaultDirectionForKey('dwellMinutes')).toBe('desc');
    expect(defaultDirectionForKey('updatedAt')).toBe('desc');
    expect(defaultDirectionForKey('title')).toBe('asc');
    expect(defaultDirectionForKey('narrativeRole')).toBe('asc');
    expect(defaultDirectionForKey('added')).toBe('asc');
  });
});

describe('normalizeCollectionSort', () => {
  it('returns the default for missing or malformed values', () => {
    expect(normalizeCollectionSort(null)).toEqual(DEFAULT_COLLECTION_SORT);
    expect(normalizeCollectionSort(undefined)).toEqual(DEFAULT_COLLECTION_SORT);
    expect(normalizeCollectionSort('title')).toEqual(DEFAULT_COLLECTION_SORT);
    expect(normalizeCollectionSort({})).toEqual(DEFAULT_COLLECTION_SORT);
  });

  it('keeps valid stored values', () => {
    expect(normalizeCollectionSort({ key: 'title', direction: 'desc' })).toEqual({ key: 'title', direction: 'desc' });
  });

  it('falls back per field for unknown values', () => {
    expect(normalizeCollectionSort({ key: 'unknown', direction: 'desc' })).toEqual({ key: 'added', direction: 'desc' });
    expect(normalizeCollectionSort({ key: 'dwellMinutes', direction: 'sideways' })).toEqual({ key: 'dwellMinutes', direction: 'desc' });
    expect(normalizeCollectionSort({ key: 'title', direction: 'sideways' })).toEqual({ key: 'title', direction: 'asc' });
  });
});

describe('serializeCollectionCsv', () => {
  it('emits rows in the exact order of the list it receives', () => {
    const items = [
      artifact({ id: 'x', accessionId: 'AF-9', title: 'Second, With Comma', maker: 'Maker "Quoted"', dwellMinutes: 3, updatedAt: '2026-09-02T10:00:00.000Z' }),
      artifact({ id: 'y', accessionId: 'AF-1', title: 'First', dwellMinutes: 8, updatedAt: '2026-08-01T10:00:00.000Z' }),
    ];
    const lines = serializeCollectionCsv(items).split('\r\n');
    expect(lines[0]).toBe('Order,Accession ID,Title,Maker,Narrative role,Sensitivity,Dwell (min),Last updated');
    expect(lines[1].startsWith('1,AF-9,"Second, With Comma","Maker ""Quoted"""')).toBe(true);
    expect(lines[1]).toContain('2026-09-02');
    expect(lines[2].startsWith('2,AF-1,First')).toBe(true);
  });

  it('names the export file with the current date', () => {
    expect(collectionListFileName(new Date('2026-09-11T12:00:00Z'))).toBe('exhibit-flow-collection-2026-09-11.csv');
  });
});
