import { describe, expect, it } from 'vitest';
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
    revision: 1,
    ...overrides,
  };
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
});

describe('zoneChecklistFileName', () => {
  it('builds a dated, slugged csv file name', () => {
    const zone = createSeedWorkspace().zones.find((candidate) => candidate.id === 'zone-common')!;
    const name = zoneChecklistFileName(zone, new Date('2026-09-07T12:00:00Z'));
    expect(name).toBe('exhibit-flow-zone-checklist-common-thread-2026-09-07.csv');
  });
});
