import { describe, expect, it } from 'vitest';
import { commitMerge, prepareMerge } from './mergeIssues';
import type { ReviewIssue, WorkspaceState } from './models';
import { createSeedWorkspace } from '../state/seed';
import { buildZoneChecklist, serializeZoneChecklistCsv, zoneChecklistFileName } from './zoneChecklist';

function stateWithIssues(extra: ReviewIssue[]): WorkspaceState {
  const seed = createSeedWorkspace();
  return { ...seed, issues: [...seed.issues, ...extra] };
}

function issue(overrides: Partial<ReviewIssue> & Pick<ReviewIssue, 'id' | 'title' | 'zoneId'>): ReviewIssue {
  return {
    description: 'Enough context for a review finding used in tests.',
    severity: 'warning',
    status: 'open',
    owner: 'Jo Renner',
    artifactId: undefined,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

function mergedState(state: WorkspaceState, ids: string[]): { state: WorkspaceState; canonical: ReviewIssue } {
  const preview = prepareMerge(state, ids);
  if (!preview.ok) throw new Error(`prepareMerge failed: ${preview.message}`);
  const result = commitMerge(state, {
    sourceIds: ids,
    reason: 'Duplicate reports of one problem.',
    expectedFingerprint: preview.preview.fingerprint,
    at: new Date('2026-09-10T10:00:00.000Z'),
    idFactory: () => 'issue-canonical-test',
  });
  if (!result.ok) throw new Error(`commitMerge failed: ${result.message}`);
  return { state: result.state, canonical: result.canonical };
}

describe('buildZoneChecklist', () => {
  it('returns null for an unknown zone', () => {
    expect(buildZoneChecklist(createSeedWorkspace(), 'zone-nope')).toBeNull();
  });

  it('lists objects in placement order with summed dwell time', () => {
    const checklist = buildZoneChecklist(createSeedWorkspace(), 'zone-common');
    expect(checklist).not.toBeNull();
    expect(checklist!.objectCount).toBe(2);
    expect(checklist!.entries.map((entry) => entry.title)).toEqual(['Portable Letterpress', 'Rain Map Quilt']);
    expect(checklist!.entries.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(checklist!.entries.map((entry) => entry.dwellMinutes)).toEqual([7, 8]);
    expect(checklist!.totalDwellMinutes).toBe(15);
  });

  it('includes unresolved object findings but excludes resolved ones', () => {
    const state = stateWithIssues([
      issue({ id: 'issue-press-mount', title: 'Press mount is wobbly', zoneId: 'zone-common', artifactId: 'artifact-press', severity: 'warning', status: 'open' }),
    ]);
    const checklist = buildZoneChecklist(state, 'zone-common')!;
    const press = checklist.entries.find((entry) => entry.artifactId === 'artifact-press')!;
    const quilt = checklist.entries.find((entry) => entry.artifactId === 'artifact-quilt')!;
    expect(press.unresolvedFindings.some((finding) => finding.title === 'Press mount is wobbly' && finding.scope === 'object')).toBe(true);
    // quilt-light is resolved in seed and must not surface
    expect(quilt.unresolvedFindings.some((finding) => finding.title.includes('quilt lux'))).toBe(false);
    expect(checklist.unresolvedCount).toBe(1);
  });

  it('attaches zone-wide findings to every row with zone scope', () => {
    const checklist = buildZoneChecklist(createSeedWorkspace(), 'zone-arrival')!;
    expect(checklist.zoneFindings).toHaveLength(1);
    expect(checklist.zoneFindings[0].title).toBe('Reduce entry panel copy');
    expect(checklist.zoneFindings[0].scope).toBe('zone');
    const lantern = checklist.entries[0];
    expect(lantern.unresolvedFindings.some((finding) => finding.scope === 'zone' && finding.title === 'Reduce entry panel copy')).toBe(true);
  });

  it('does not leak findings from other zones or their objects', () => {
    const checklist = buildZoneChecklist(createSeedWorkspace(), 'zone-arrival')!;
    const titles = checklist.entries.flatMap((entry) => entry.unresolvedFindings.map((finding) => finding.title));
    expect(titles.some((title) => title.includes('transcript'))).toBe(false);
  });

  it('counts merged duplicates once through their canonical record', () => {
    const state = stateWithIssues([
      issue({ id: 'issue-lux-a', title: 'Quilt lux report from curator', zoneId: 'zone-common', artifactId: 'artifact-quilt', severity: 'critical' }),
      issue({ id: 'issue-lux-b', title: 'Quilt lux report from floor walk', zoneId: 'zone-common', artifactId: 'artifact-quilt' }),
    ]);
    const before = buildZoneChecklist(state, 'zone-common')!;
    expect(before.unresolvedCount).toBe(2);

    const { state: merged, canonical } = mergedState(state, ['issue-lux-a', 'issue-lux-b']);
    const after = buildZoneChecklist(merged, 'zone-common')!;
    expect(after.unresolvedCount).toBe(1);

    const quilt = after.entries.find((entry) => entry.artifactId === 'artifact-quilt')!;
    const objectFindings = quilt.unresolvedFindings.filter((finding) => finding.scope === 'object');
    expect(objectFindings).toHaveLength(1);
    expect(objectFindings[0].title).toBe(canonical.title);
    expect(objectFindings[0].severity).toBe('critical');
  });

  it('surfaces a canonical record in every linked zone without double counting', () => {
    const state = stateWithIssues([
      issue({ id: 'issue-zone-a', title: 'Shared problem seen in Common Thread', zoneId: 'zone-common' }),
      issue({ id: 'issue-zone-b', title: 'Same problem seen in Afterlives', zoneId: 'zone-after' }),
    ]);
    const { state: merged } = mergedState(state, ['issue-zone-a', 'issue-zone-b']);

    const common = buildZoneChecklist(merged, 'zone-common')!;
    const after = buildZoneChecklist(merged, 'zone-after')!;
    expect(common.zoneFindings.filter((finding) => finding.title === 'Shared problem seen in Common Thread')).toHaveLength(1);
    expect(after.zoneFindings.filter((finding) => finding.title === 'Shared problem seen in Common Thread')).toHaveLength(1);
    // Seed contributes one zone-wide finding to zone-arrival only; counts stay scoped.
    expect(common.unresolvedCount).toBe(1);
    expect(after.unresolvedCount).toBe(2); // canonical + seed transcript finding on the tape object
  });
});

describe('serializeZoneChecklistCsv', () => {
  it('renders metadata, object rows, dwell and findings as CSV', () => {
    const checklist = buildZoneChecklist(createSeedWorkspace(), 'zone-arrival')!;
    const csv = serializeZoneChecklistCsv(checklist);
    expect(csv).toContain('Arrival / A Light Carried');
    expect(csv).toContain('Railway Signal Lantern');
    expect(csv).toContain('Reduce entry panel copy');
    expect(csv).toContain('Order,Accession ID,Object,Dwell (min),Unresolved findings');
  });

  it('quotes fields containing commas', () => {
    const state = stateWithIssues([
      issue({ id: 'issue-comma', title: 'Mount, base loose', zoneId: 'zone-patterns', artifactId: 'artifact-sample-book', severity: 'warning', status: 'open' }),
    ]);
    const csv = serializeZoneChecklistCsv(buildZoneChecklist(state, 'zone-patterns')!);
    expect(csv).toContain('"[WARNING] Mount, base loose (Jo Renner, open)"');
  });

  it('exports the canonical record once and drops merged source titles', () => {
    const state = stateWithIssues([
      issue({ id: 'issue-dup-a', title: 'Floor team duplicate', zoneId: 'zone-common', artifactId: 'artifact-quilt', severity: 'critical' }),
      issue({ id: 'issue-dup-b', title: 'Curatorial duplicate', zoneId: 'zone-common', artifactId: 'artifact-quilt' }),
    ]);
    const { state: merged, canonical } = mergedState(state, ['issue-dup-a', 'issue-dup-b']);
    const csv = serializeZoneChecklistCsv(buildZoneChecklist(merged, 'zone-common')!);

    expect(csv).toContain(`[CRITICAL] ${canonical.title}`);
    expect(csv).not.toContain('Curatorial duplicate');
    expect(csv).toContain('Unresolved findings: 1');
    // The canonical title appears exactly once across the whole CSV.
    expect(csv.split(canonical.title).length - 1).toBe(1);
  });
});

describe('zoneChecklistFileName', () => {
  it('builds a dated, slugged csv file name', () => {
    const zone = createSeedWorkspace().zones.find((candidate) => candidate.id === 'zone-common')!;
    const name = zoneChecklistFileName(zone, new Date('2026-09-07T12:00:00Z'));
    expect(name).toBe('exhibit-flow-zone-checklist-common-thread-2026-09-07.csv');
  });
});
