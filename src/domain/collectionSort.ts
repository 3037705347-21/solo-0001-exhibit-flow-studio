import type { Artifact, NarrativeRole } from './models';

export type CollectionSortKey = 'added' | 'title' | 'dwellMinutes' | 'updatedAt' | 'narrativeRole';
export type SortDirection = 'asc' | 'desc';

export interface CollectionSort {
  key: CollectionSortKey;
  direction: SortDirection;
}

export const COLLECTION_SORT_KEYS: CollectionSortKey[] = ['added', 'title', 'dwellMinutes', 'updatedAt', 'narrativeRole'];
export const SORT_DIRECTIONS: SortDirection[] = ['asc', 'desc'];

/** The collection opens in added order, matching how objects entered the workspace. */
export const DEFAULT_COLLECTION_SORT: CollectionSort = { key: 'added', direction: 'asc' };

export const collectionSortLabels: Record<CollectionSortKey, string> = {
  added: 'Added order',
  title: 'Title',
  dwellMinutes: 'Dwell time',
  updatedAt: 'Recently updated',
  narrativeRole: 'Narrative role',
};

/** Roles compare in story-arc order, not alphabetically. */
const ROLE_ORDER: NarrativeRole[] = ['threshold', 'context', 'turning-point', 'reflection'];

/** Longest dwell and most recent edits are the useful defaults; everything else starts ascending. */
export function defaultDirectionForKey(key: CollectionSortKey): SortDirection {
  return key === 'dwellMinutes' || key === 'updatedAt' ? 'desc' : 'asc';
}

/**
 * Locale-independent text comparison so the same collection sorts identically
 * in every browser, test run, and printed export. Case-insensitive first, then
 * exact code-unit order so differently cased titles still have a fixed order.
 */
function compareText(left: string, right: string): number {
  const foldedLeft = left.toLowerCase();
  const foldedRight = right.toLowerCase();
  if (foldedLeft < foldedRight) return -1;
  if (foldedLeft > foldedRight) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareTimestamp(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) return compareText(left, right);
  return leftTime - rightTime;
}

function primaryComparison(left: Artifact, right: Artifact, key: CollectionSortKey): number {
  switch (key) {
    case 'added':
      return compareTimestamp(left.createdAt, right.createdAt);
    case 'title':
      return compareText(left.title, right.title);
    case 'dwellMinutes':
      return left.dwellMinutes - right.dwellMinutes;
    case 'updatedAt':
      return compareTimestamp(left.updatedAt, right.updatedAt);
    case 'narrativeRole':
      return ROLE_ORDER.indexOf(left.narrativeRole) - ROLE_ORDER.indexOf(right.narrativeRole);
  }
}

/**
 * Equal primary values are separated by a fixed chain — title, then the unique
 * accession ID, then the internal ID — always ascending, never flipped by the
 * sort direction. Because accession IDs are unique, every pair of valid objects
 * has exactly one legal order under any sort key.
 */
function tieBreak(left: Artifact, right: Artifact, key: CollectionSortKey): number {
  if (key !== 'title') {
    const byTitle = compareText(left.title, right.title);
    if (byTitle !== 0) return byTitle;
  }
  const byAccession = compareText(left.accessionId, right.accessionId);
  if (byAccession !== 0) return byAccession;
  return compareText(left.id, right.id);
}

export function compareArtifacts(left: Artifact, right: Artifact, sort: CollectionSort): number {
  const primary = primaryComparison(left, right, sort.key);
  if (primary !== 0) return sort.direction === 'desc' ? -primary : primary;
  return tieBreak(left, right, sort.key);
}

/**
 * Returns a new array; the workspace artifact list is never reordered in place.
 * Filtering a sorted result preserves relative order, so search and filters can
 * be applied afterwards without disturbing the comparison rule.
 */
export function sortCollection(artifacts: Artifact[], sort: CollectionSort = DEFAULT_COLLECTION_SORT): Artifact[] {
  return [...artifacts].sort((left, right) => compareArtifacts(left, right, sort));
}

/**
 * Restore rule for persisted sort state: each field is validated on its own and
 * unknown values fall back to the documented default, so a corrupted or older
 * stored preference can never produce an unpredictable order.
 */
export function normalizeCollectionSort(value: unknown): CollectionSort {
  if (!value || typeof value !== 'object') return DEFAULT_COLLECTION_SORT;
  const candidate = value as Partial<CollectionSort>;
  const key = COLLECTION_SORT_KEYS.includes(candidate.key as CollectionSortKey)
    ? (candidate.key as CollectionSortKey)
    : DEFAULT_COLLECTION_SORT.key;
  const direction = SORT_DIRECTIONS.includes(candidate.direction as SortDirection)
    ? (candidate.direction as SortDirection)
    : defaultDirectionForKey(key);
  return { key, direction };
}
