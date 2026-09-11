import type { ArchiveEntry, ArchiveSortMode } from '../domain/archive';
import type { Snapshot } from '../domain/models';

/**
 * The archive lives in its own storage slot. It is deliberately separate from
 * the live workspace key: importing, deleting, or rebuilding an archive must
 * never mutate the plan the curator is working on, and resetting the sample
 * plan must not erase archived history.
 */
export const ARCHIVE_KEY = 'exhibit-flow.plan-archive.v1';
export const ARCHIVE_UI_KEY = 'exhibit-flow.plan-archive-ui.v1';

const DEFAULT_SORT: ArchiveSortMode = 'recent';
const SORT_MODES: ArchiveSortMode[] = ['recent', 'title'];

function isSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Snapshot>;
  return candidate.schemaVersion === 1
    && Boolean(candidate.project)
    && Boolean(candidate.summary)
    && Array.isArray(candidate.zones);
}

function isArchiveEntry(value: unknown): value is ArchiveEntry {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ArchiveEntry>;
  return typeof candidate.id === 'string'
    && typeof candidate.planId === 'string'
    && typeof candidate.contentHash === 'string'
    && typeof candidate.generatedAt === 'string'
    && typeof candidate.importedAt === 'string'
    && typeof candidate.lastImportedAt === 'string'
    && typeof candidate.importCount === 'number'
    && typeof candidate.version === 'number'
    && isSnapshot(candidate.snapshot);
}

/** Tolerate one corrupt record (or an older shape) by dropping it instead of losing the whole archive. */
export function loadArchiveEntries(storage: Pick<Storage, 'getItem'> = localStorage): ArchiveEntry[] {
  try {
    const raw = storage.getItem(ARCHIVE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isArchiveEntry);
  } catch {
    return [];
  }
}

export function saveArchiveEntries(entries: readonly ArchiveEntry[], storage: Pick<Storage, 'setItem'> = localStorage): boolean {
  try {
    storage.setItem(ARCHIVE_KEY, JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
}

export function loadArchiveSort(storage: Pick<Storage, 'getItem'> = localStorage): ArchiveSortMode {
  try {
    const raw = storage.getItem(ARCHIVE_UI_KEY);
    if (!raw) return DEFAULT_SORT;
    const parsed: unknown = JSON.parse(raw);
    const mode = parsed && typeof parsed === 'object' ? (parsed as { sort?: unknown }).sort : undefined;
    return typeof mode === 'string' && (SORT_MODES as string[]).includes(mode)
      ? (mode as ArchiveSortMode)
      : DEFAULT_SORT;
  } catch {
    return DEFAULT_SORT;
  }
}

export function saveArchiveSort(mode: ArchiveSortMode, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(ARCHIVE_UI_KEY, JSON.stringify({ sort: mode }));
  } catch {
    // UI preferences are non-critical; ignore storage failures.
  }
}
