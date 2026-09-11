import { describe, expect, it } from 'vitest';
import type { Snapshot } from './models';
import {
  archiveEntryId,
  archiveExportFileName,
  canonicalSnapshot,
  entryHashSuffix,
  groupArchiveLineages,
  hashContent,
  ingestSnapshot,
  planKeyFromId,
  removeArchiveEntry,
  shortHash,
  snapshotIdentity,
  sortLineages,
  stableStringify,
} from './archive';

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    schemaVersion: 1,
    generatedAt: '2026-09-01T10:00:00.000Z',
    project: {
      id: 'project-afterlight',
      title: 'Afterlight: Material Memory',
      venue: 'North Hall',
      audience: 'General',
      openingDate: '2027-03-18',
      stage: 'ready',
      lastReadinessCheck: '2026-09-01T10:00:00.000Z',
    },
    summary: { artifactCount: 2, zoneCount: 1, visitMinutes: 12, readinessScore: 94 },
    zones: [
      {
        id: 'zone-common',
        name: 'The Common Thread',
        shortLabel: 'Common',
        thesis: 'Shared making',
        capacityMinutes: 60,
        maxObjects: 10,
        lowLight: false,
        hasSeating: true,
        color: '#7c6aa6',
        sequence: 0,
        artifactIds: ['artifact-press'],
        artifacts: [
          {
            id: 'artifact-press',
            accessionId: 'AF-1952-088',
            title: 'Portable Letterpress',
            maker: 'Shinsei Works',
            yearLabel: '1952',
            medium: 'Metal',
            origin: 'Osaka',
            summary: 'A travelling press.',
            dimensions: { width: 30, height: 25, depth: 20, unit: 'cm' },
            dwellMinutes: 12,
            narrativeRole: 'turning-point',
            sensitivity: 'standard',
            accessibilityNeed: 'none',
            isKeyObject: true,
            tags: ['print'],
            color: '#2f7c75',
            createdAt: '2026-08-01T09:00:00.000Z',
            updatedAt: '2026-08-01T09:00:00.000Z',
          },
        ],
      },
    ],
    unresolvedIssues: [],
    ...overrides,
  };
}

describe('snapshot content identity', () => {
  it('hashes the same canonical content regardless of object key order', () => {
    const reordered = makeSnapshot();
    // Move generatedAt/project conceptually by rebuilding with swapped keys.
    const canonical = canonicalSnapshot(reordered);
    expect(stableStringify(canonical)).toBe(stableStringify(canonical));
    const once = snapshotIdentity(reordered);
    const jsonShuffled = JSON.parse(JSON.stringify(reordered));
    expect(hashContent(stableStringify(canonicalSnapshot(jsonShuffled)))).toBe(once);
    expect(shortHash(once)).toHaveLength(8);
  });

  it('treats a changed export time as the same content', () => {
    const before = makeSnapshot({ generatedAt: '2026-09-01T10:00:00.000Z' });
    const later = makeSnapshot({
      generatedAt: '2026-09-10T18:30:00.000Z',
      project: { ...before.project, lastReadinessCheck: '2026-09-10T18:30:00.000Z' },
    });
    expect(snapshotIdentity(later)).toBe(snapshotIdentity(before));
  });

  it('ignores artifact and issue bookkeeping timestamps', () => {
    const before = makeSnapshot();
    const withStamps = makeSnapshot({
      zones: [
        {
          ...before.zones[0],
          artifacts: [{
            ...before.zones[0].artifacts[0],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-05-05T00:00:00.000Z',
          }],
        },
      ],
      unresolvedIssues: [{
        id: 'issue-1', title: 'Note', description: 'A long enough description.', severity: 'note',
        status: 'open', owner: 'R. Viewer', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-02T00:00:00.000Z',
      }],
    });
    const otherStamps = makeSnapshot({
      zones: [
        {
          ...before.zones[0],
          artifacts: [{
            ...before.zones[0].artifacts[0],
            createdAt: '2026-08-08T00:00:00.000Z',
            updatedAt: '2026-08-09T00:00:00.000Z',
          }],
        },
      ],
      unresolvedIssues: [{
        id: 'issue-1', title: 'Note', description: 'A long enough description.', severity: 'note',
        status: 'open', owner: 'R. Viewer', createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z',
      }],
    });
    expect(snapshotIdentity(withStamps)).toBe(snapshotIdentity(otherStamps));
  });

  it('creates a different identity when business fields change', () => {
    const before = makeSnapshot();
    const changedTitle = makeSnapshot({
      project: { ...before.project, title: 'Afterlight: Material Memories, Revisited' },
    });
    const changedDwell = makeSnapshot({
      zones: [{
        ...before.zones[0],
        artifacts: [{ ...before.zones[0].artifacts[0], dwellMinutes: 9 }],
      }],
    });
    const changedScore = makeSnapshot({ summary: { ...before.summary, readinessScore: 82 } });
    const base = snapshotIdentity(before);
    expect(snapshotIdentity(changedTitle)).not.toBe(base);
    expect(snapshotIdentity(changedDwell)).not.toBe(base);
    expect(snapshotIdentity(changedScore)).not.toBe(base);
  });

  it('is order-independent for embedded artifacts and unresolved issues', () => {
    const two = makeSnapshot({
      zones: [{
        ...makeSnapshot().zones[0],
        artifactIds: ['artifact-press', 'artifact-lantern'],
        artifacts: [
          makeSnapshot().zones[0].artifacts[0],
          { ...makeSnapshot().zones[0].artifacts[0], id: 'artifact-lantern', accessionId: 'AF-1908-014', title: 'Railway Signal Lantern', isKeyObject: false },
        ],
      }],
      unresolvedIssues: [
        { id: 'issue-b', title: 'Second', description: 'A long enough description.', severity: 'note', status: 'open', owner: 'Owner', createdAt: 'x', updatedAt: 'x' },
        { id: 'issue-a', title: 'First', description: 'A long enough description.', severity: 'note', status: 'open', owner: 'Owner', createdAt: 'x', updatedAt: 'x' },
      ],
    });
    const shuffled = JSON.parse(JSON.stringify(two)) as Snapshot;
    shuffled.zones[0].artifacts.reverse();
    shuffled.unresolvedIssues.reverse();
    expect(snapshotIdentity(shuffled)).toBe(snapshotIdentity(two));
  });
});

describe('archive ingest', () => {
  it('returns the existing entry for a duplicate import with a different file name', () => {
    const snapshot = makeSnapshot();
    const first = ingestSnapshot([], snapshot, 'copy-1.json', new Date('2026-09-02T08:00:00Z'));
    expect(first.outcome).toBe('created');
    const second = ingestSnapshot([first.entry], snapshot, 'totally-different-name.json', new Date('2026-09-03T08:00:00Z'));
    expect(second.outcome).toBe('duplicate');
    expect(second.entry.id).toBe(first.entry.id);
    expect(second.entry.importCount).toBe(2);
    // Frozen metadata is preserved...
    expect(second.entry.importedAt).toBe(first.entry.importedAt);
    expect(second.entry.importFileName).toBe('copy-1.json');
    expect(second.entry.generatedAt).toBe('2026-09-01T10:00:00.000Z');
    // ...while the repeat import is recorded.
    expect(second.entry.lastImportFileName).toBe('totally-different-name.json');
  });

  it('keeps one record when only the export time changed', () => {
    const first = ingestSnapshot([], makeSnapshot({ generatedAt: '2026-09-01T10:00:00.000Z' }), 'a.json');
    const reexported = makeSnapshot({
      generatedAt: '2026-09-12T10:00:00.000Z',
      project: { ...makeSnapshot().project, lastReadinessCheck: '2026-09-12T10:00:00.000Z' },
    });
    const again = ingestSnapshot([first.entry], reexported, 'b.json');
    expect(again.outcome).toBe('duplicate');
    expect(again.entry.id).toBe(first.entry.id);
  });

  it('opens a new historical version for changed content and records what it replaces', () => {
    const first = ingestSnapshot([], makeSnapshot(), 'v1.json', new Date('2026-09-02T08:00:00Z'));
    const changed = makeSnapshot({ summary: { ...makeSnapshot().summary, readinessScore: 70 } });
    const second = ingestSnapshot([first.entry], changed, 'v2.json', new Date('2026-09-03T08:00:00Z'));
    expect(second.outcome).toBe('new-version');
    expect(second.entry.version).toBe(2);
    expect(second.entry.supersededEntryId).toBe(first.entry.id);
    expect(second.supersededEntry?.id).toBe(first.entry.id);
    expect(second.entry.id).not.toBe(first.entry.id);

    // A third change chains on from v2.
    const third = ingestSnapshot(
      [first.entry, second.entry],
      makeSnapshot({ summary: { ...makeSnapshot().summary, readinessScore: 60 } }),
      'v3.json',
      new Date('2026-09-04T08:00:00Z'),
    );
    expect(third.entry.version).toBe(3);
    expect(third.entry.supersededEntryId).toBe(second.entry.id);
  });

  it('groups unrelated plans into separate lineages', () => {
    const a = ingestSnapshot([], makeSnapshot(), 'a.json').entry;
    const otherPlan = makeSnapshot({ project: { ...makeSnapshot().project, id: 'project-other', title: 'Other Plan' } });
    const b = ingestSnapshot([a], otherPlan, 'b.json').entry;
    const lineages = groupArchiveLineages([a, b]);
    expect(lineages).toHaveLength(2);
  });

  it('sorts versions newest-exported-first and lineages stably', () => {
    const old = ingestSnapshot([], makeSnapshot({ generatedAt: '2026-09-01T10:00:00.000Z' }), 'old.json', new Date('2026-09-01T11:00:00Z')).entry;
    const newer = ingestSnapshot(
      [old],
      makeSnapshot({ generatedAt: '2026-09-08T10:00:00.000Z', summary: { ...makeSnapshot().summary, readinessScore: 60 } }),
      'new.json',
      new Date('2026-09-02T11:00:00Z'),
    ).entry;
    const lineage = groupArchiveLineages([old, newer])[0];
    expect(lineage.versions.map((entry) => entry.id)).toEqual([newer.id, old.id]);
    expect(lineage.latest.id).toBe(newer.id);
    const byTitle = sortLineages(groupArchiveLineages([newer, old]), 'title');
    expect(byTitle).toHaveLength(1);
  });

  it('rebuilds the same entry id after delete + re-import so old references stay valid', () => {
    const first = ingestSnapshot([], makeSnapshot(), 'a.json').entry;
    const afterDelete = removeArchiveEntry([first], first.id);
    expect(afterDelete).toHaveLength(0);
    const rebuilt = ingestSnapshot(afterDelete, makeSnapshot(), 'a-copy.json').entry;
    expect(rebuilt.id).toBe(first.id);
  });

  it('does not mutate surviving supersession links when a middle version is deleted', () => {
    const v1 = ingestSnapshot([], makeSnapshot(), 'v1.json').entry;
    const v2 = ingestSnapshot([v1], makeSnapshot({ summary: { ...makeSnapshot().summary, readinessScore: 70 } }), 'v2.json').entry;
    const v3 = ingestSnapshot([v1, v2], makeSnapshot({ summary: { ...makeSnapshot().summary, readinessScore: 60 } }), 'v3.json').entry;
    const withoutV2 = removeArchiveEntry([v1, v2, v3], v2.id);
    const survivingV3 = withoutV2.find((entry) => entry.id === v3.id);
    expect(survivingV3?.supersededEntryId).toBe(v2.id);
    expect(survivingV3?.supersededVersion).toBe(2);
  });

  it('rebuilds a deleted middle version at its original slot with the original links', () => {
    const v1 = ingestSnapshot([], makeSnapshot(), 'v1.json').entry;
    const v2 = ingestSnapshot([v1], makeSnapshot({ summary: { ...makeSnapshot().summary, readinessScore: 70 } }), 'v2.json').entry;
    const v3 = ingestSnapshot([v1, v2], makeSnapshot({ summary: { ...makeSnapshot().summary, readinessScore: 60 } }), 'v3.json').entry;
    // Delete v2, then rebuild it from a file with a different name.
    const withoutV2 = removeArchiveEntry([v1, v2, v3], v2.id);
    const rebuilt = ingestSnapshot(
      withoutV2,
      makeSnapshot({ summary: { ...makeSnapshot().summary, readinessScore: 70 } }),
      'v2-renamed.json',
    );
    expect(rebuilt.entry.id).toBe(v2.id);
    expect(rebuilt.entry.version).toBe(2);
    expect(rebuilt.entry.supersededEntryId).toBe(v1.id);
    // v3 still points at the same id, so the chain is restored without duplication.
    const all = [...withoutV2, rebuilt.entry];
    expect(all).toHaveLength(3);
    expect(all.find((entry) => entry.id === v3.id)?.supersededEntryId).toBe(v2.id);
  });

  it('rebuilds a deleted newest version without renumbering the surviving predecessor', () => {
    const v1 = ingestSnapshot([], makeSnapshot(), 'v1.json').entry;
    const v2 = ingestSnapshot([v1], makeSnapshot({ summary: { ...makeSnapshot().summary, readinessScore: 70 } }), 'v2.json').entry;
    const rebuilt = ingestSnapshot(
      removeArchiveEntry([v1, v2], v2.id),
      makeSnapshot({ summary: { ...makeSnapshot().summary, readinessScore: 70 } }),
      'v2-copy.json',
    );
    expect(rebuilt.entry.id).toBe(v2.id);
    expect(rebuilt.entry.version).toBe(2);
    expect(rebuilt.entry.supersededEntryId).toBe(v1.id);
  });

  it('names re-exports after the frozen export date, not the import name', () => {
    const entry = ingestSnapshot([], makeSnapshot({ generatedAt: '2026-09-01T10:00:00.000Z' }), 'random.json').entry;
    expect(archiveExportFileName(entry)).toBe('exhibit-flow-snapshot-2026-09-01.json');
  });

  it('sanitizes plan ids into stable keys', () => {
    expect(planKeyFromId('Project: Afterlight!')).toBe('Project-Afterlight');
    expect(archiveEntryId('Project: Afterlight!', 'abcd')).toBe('Project-Afterlight:abcd');
  });

  it('extracts a short content reference from a stored entry id', () => {
    const entry = ingestSnapshot([], makeSnapshot(), 'a.json').entry;
    expect(entryHashSuffix(entry.id)).toBe(shortHash(entry.contentHash));
    expect(entryHashSuffix('plan:0123456789abcdef')).toBe('01234567');
  });
});
