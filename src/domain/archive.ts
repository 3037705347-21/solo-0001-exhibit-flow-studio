import type { Snapshot } from './models';

/**
 * Archived snapshots are identified by their *business content*, never by the
 * file name they arrived in or the moment they were exported. Two imports of
 * the same plan must collapse onto one archive record; only a real change to
 * the plan opens a new historical version.
 */

export interface ArchiveEntry {
  /** Stable for the life of the content: `planKey:contentHash`. Rebuilding an archive after deleting it yields the same id. */
  id: string;
  planId: string;
  planKey: string;
  projectTitle: string;
  venue: string;
  contentHash: string;
  /** Frozen export time taken from the snapshot; never updated by duplicate imports. */
  generatedAt: string;
  importedAt: string;
  lastImportedAt: string;
  importCount: number;
  importFileName: string;
  lastImportFileName?: string;
  /** Position of this content in the plan's lineage, assigned from the highest version this content ever held (1-based). */
  version: number;
  /** The entry that was the highest version of this plan when the entry first arrived. */
  supersededEntryId?: string;
  /** Remembers the slot of a deleted predecessor so it can be rebuilt at the same version. */
  supersededVersion?: number;
  snapshot: Snapshot;
}

export type IngestOutcome = 'created' | 'duplicate' | 'new-version';

export interface ArchiveIngestResult {
  entry: ArchiveEntry;
  outcome: IngestOutcome;
  /** Present when a different content hash replaces an earlier on-file version. */
  supersededEntry?: ArchiveEntry;
}

export type ArchiveSortMode = 'recent' | 'title';

const TIMESTAMP_KEYS = new Set(['createdAt', 'updatedAt', 'resolvedAt', 'lastReadinessCheck', 'generatedAt']);

/** Recursively drop bookkeeping timestamps: re-exporting the same plan at another time must not change identity. */
function stripTimestamps<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => stripTimestamps(item)) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key, item]) => !TIMESTAMP_KEYS.has(key) && typeof item !== 'undefined')
        .map(([key, item]) => [key, stripTimestamps(item)]),
    ) as unknown as T;
  }
  return value;
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Deterministic JSON: sorted object keys so property order can never change identity. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => typeof item !== 'undefined')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

/** FNV-1a, 64-bit. Short, synchronous, and collision-resistant enough for local archive identity. */
export function hashContent(text: string): string {
  const offsetBasis = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  let hash = offsetBasis;
  for (const byte of new TextEncoder().encode(text)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * prime);
  }
  return hash.toString(16).padStart(16, '0');
}

export function shortHash(contentHash: string): string {
  return contentHash.slice(0, 8);
}

/** A supersession link can outlive the entry it points to (that version was deleted). */
export function entryHashSuffix(entryId: string): string {
  const parts = entryId.split(':');
  return shortHash(parts[parts.length - 1] ?? '');
}

/**
 * Canonical business view of a snapshot.
 * - export/readiness timestamps are stripped (only metadata),
 * - zones are ordered by visit sequence then id, and the artifacts embedded in
 *   a zone are ordered by id (placement order already lives in `artifactIds`),
 * - unresolved issues are ordered by id.
 */
export function canonicalSnapshot(snapshot: Snapshot): unknown {
  const zones = [...(snapshot.zones ?? [])]
    .map((zone) => ({
      ...stripTimestamps(zone),
      artifacts: [...(zone.artifacts ?? [])].map((artifact) => stripTimestamps(artifact)).sort(byId),
    }))
    .sort((a, b) => (a.sequence - b.sequence) || byId(a, b));
  return {
    schemaVersion: snapshot.schemaVersion,
    project: stripTimestamps(snapshot.project),
    summary: snapshot.summary,
    zones,
    unresolvedIssues: [...(snapshot.unresolvedIssues ?? [])]
      .map((issue) => stripTimestamps(issue))
      .sort(byId),
  };
}

export function snapshotIdentity(snapshot: Snapshot): string {
  return hashContent(stableStringify(canonicalSnapshot(snapshot)));
}

export function planKeyFromId(planId: string): string {
  const key = planId.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return key || 'unknown-plan';
}

export function archiveEntryId(planId: string, contentHash: string): string {
  return `${planKeyFromId(planId)}:${contentHash}`;
}

function newestImported(entries: ArchiveEntry[]): ArchiveEntry | undefined {
  return entries.reduce<ArchiveEntry | undefined>((newest, entry) => {
    if (!newest) return entry;
    const at = Date.parse(entry.lastImportedAt) || 0;
    const bestAt = Date.parse(newest.lastImportedAt) || 0;
    return at > bestAt || (at === bestAt && entry.version > newest.version) ? entry : newest;
  }, undefined);
}

/**
 * Fold an imported snapshot into the archive.
 * - identical content (any file name, any export time) returns the existing entry,
 * - changed content for the same plan becomes a new version and records what it replaces.
 * Pure: pass the clock in so repeat calls stay reproducible.
 */
export function ingestSnapshot(
  entries: readonly ArchiveEntry[],
  snapshot: Snapshot,
  fileName: string,
  at: Date = new Date(),
): ArchiveIngestResult {
  const planId = (snapshot.project.id || 'unknown-plan').trim() || 'unknown-plan';
  const contentHash = snapshotIdentity(snapshot);
  const id = archiveEntryId(planId, contentHash);
  const stampedAt = at.toISOString();

  const existing = entries.find((entry) => entry.id === id);
  if (existing) {
    return {
      outcome: 'duplicate',
      entry: {
        ...existing,
        lastImportedAt: stampedAt,
        lastImportFileName: fileName,
        importCount: existing.importCount + 1,
      },
    };
  }

  const lineage = entries.filter((entry) => entry.planId === planId);
  // A deleted entry can be rebuilt from its snapshot later. A surviving later
  // version remembers the gap through its supersession link: if some entry's
  // predecessor hash matches this content, the import reclaims that version
  // slot instead of being appended as yet another version.
  const restorer = lineage.find((entry) =>
    entry.supersededEntryId?.endsWith(`:${contentHash}`));
  const restoredVersion = restorer?.supersededVersion;
  const version = typeof restoredVersion === 'number'
    ? restoredVersion
    : lineage.length === 0 ? 1 : Math.max(...lineage.map((item) => item.version)) + 1;
  const predecessor = typeof restoredVersion === 'number'
    ? [...lineage].filter((item) => item.version < version)
      .sort((a, b) => b.version - a.version)[0]
    : newestImported(lineage);
  const entry: ArchiveEntry = {
    id,
    planId,
    planKey: planKeyFromId(planId),
    projectTitle: snapshot.project.title,
    venue: snapshot.project.venue,
    contentHash,
    generatedAt: snapshot.generatedAt,
    importedAt: stampedAt,
    lastImportedAt: stampedAt,
    importCount: 1,
    importFileName: fileName,
    version,
    supersededEntryId: predecessor?.id,
    supersededVersion: predecessor?.version,
    snapshot,
  };
  const outcome: IngestOutcome = lineage.length === 0 ? 'created' : 'new-version';
  return { outcome, entry, supersededEntry: predecessor };
}

export function removeArchiveEntry(entries: readonly ArchiveEntry[], entryId: string): ArchiveEntry[] {
  return entries.filter((entry) => entry.id !== entryId);
}

export function compareExported(a: ArchiveEntry, b: ArchiveEntry): number {
  const at = Date.parse(a.generatedAt) || 0;
  const bt = Date.parse(b.generatedAt) || 0;
  if (at !== bt) return bt - at;
  const ia = Date.parse(a.importedAt) || 0;
  const ib = Date.parse(b.importedAt) || 0;
  if (ia !== ib) return ib - ia;
  if (a.version !== b.version) return b.version - a.version;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface ArchiveLineage {
  planId: string;
  planKey: string;
  projectTitle: string;
  venue: string;
  latest: ArchiveEntry;
  versions: ArchiveEntry[];
}

/** Group entries by plan and sort versions newest-exported-first, with deterministic tie-breaks. */
export function groupArchiveLineages(entries: readonly ArchiveEntry[]): ArchiveLineage[] {
  const groups = new Map<string, ArchiveEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.planId);
    if (group) group.push(entry);
    else groups.set(entry.planId, [entry]);
  }
  return [...groups.values()].map((group) => {
    const versions = [...group].sort(compareExported);
    const latest = versions[0];
    return {
      planId: latest.planId,
      planKey: latest.planKey,
      projectTitle: latest.projectTitle,
      venue: latest.venue,
      latest,
      versions,
    };
  });
}

export function sortLineages(lineages: readonly ArchiveLineage[], mode: ArchiveSortMode): ArchiveLineage[] {
  const sorted = [...lineages];
  if (mode === 'title') {
    sorted.sort((a, b) =>
      a.projectTitle.localeCompare(b.projectTitle) || a.planId.localeCompare(b.planId));
  } else {
    sorted.sort((a, b) =>
      (Date.parse(b.latest.lastImportedAt) || 0) - (Date.parse(a.latest.lastImportedAt) || 0)
      || a.projectTitle.localeCompare(b.projectTitle)
      || a.planId.localeCompare(b.planId));
  }
  return sorted;
}

/** Re-export name always reflects the frozen export date, not today or the import file name. */
export function archiveExportFileName(entry: ArchiveEntry): string {
  const exported = Date.parse(entry.generatedAt);
  if (Number.isNaN(exported)) return 'exhibit-flow-snapshot-undated.json';
  return `exhibit-flow-snapshot-${entry.generatedAt.slice(0, 10)}.json`;
}
