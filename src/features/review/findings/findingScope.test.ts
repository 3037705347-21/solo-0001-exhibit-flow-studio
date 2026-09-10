import { describe, expect, it } from 'vitest';
import type { ReviewIssue, WorkspaceState, Zone } from '../../../domain/models';
import { createSeedWorkspace } from '../../../state/seed';
import { countByStatus, filterIssuesByStatus, isIssueInZone, scopeIssuesToZone } from './findingScope';

function zone(id: string, artifactIds: string[]): Zone {
  return {
    id, name: id, shortLabel: id, thesis: '', capacityMinutes: 10, maxObjects: 2,
    lowLight: false, hasSeating: false, color: '#000', sequence: 0, artifactIds,
  };
}

function issue(overrides: Partial<ReviewIssue> = {}): ReviewIssue {
  return {
    id: 'issue-x',
    title: 'Title',
    description: 'Enough context for a review finding used in tests.',
    severity: 'warning',
    status: 'open',
    owner: 'Jo Renner',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('isIssueInZone', () => {
  it('matches findings linked to the zone directly', () => {
    expect(isIssueInZone(issue({ zoneId: 'zone-a' }), zone('zone-a', []))).toBe(true);
    expect(isIssueInZone(issue({ zoneId: 'zone-b' }), zone('zone-a', []))).toBe(false);
  });

  it('matches findings attached to an object placed in the zone', () => {
    expect(isIssueInZone(issue({ artifactId: 'artifact-1' }), zone('zone-a', ['artifact-1']))).toBe(true);
    expect(isIssueInZone(issue({ artifactId: 'artifact-2' }), zone('zone-a', ['artifact-1']))).toBe(false);
  });

  it('matches an object finding even when its own zone link points elsewhere', () => {
    expect(
      isIssueInZone(issue({ zoneId: 'zone-b', artifactId: 'artifact-1' }), zone('zone-a', ['artifact-1'])),
    ).toBe(true);
  });

  it('treats an empty artifact id as no object link', () => {
    expect(isIssueInZone(issue({ artifactId: '' }), zone('zone-a', ['artifact-1']))).toBe(false);
  });
});

describe('scopeIssuesToZone', () => {
  it('passes every finding through without a zone (overview)', () => {
    const state: WorkspaceState = createSeedWorkspace();
    expect(scopeIssuesToZone(state.issues)).toBe(state.issues);
    expect(scopeIssuesToZone(state.issues, null)).toBe(state.issues);
  });

  it('keeps direct zone findings and findings on objects placed in the zone', () => {
    const state = createSeedWorkspace();
    const arrival = state.zones.find((candidate) => candidate.id === 'zone-arrival')!;
    const scoped = scopeIssuesToZone(state.issues, arrival);
    expect(scoped.map((candidate) => candidate.id)).toEqual(['issue-entry-copy']);
  });

  it('includes findings on placed objects via artifact link even without a matching zoneId', () => {
    const after = zone('zone-after', ['artifact-tape']);
    const scoped = scopeIssuesToZone([
      issue({ id: 'tape-note', zoneId: 'zone-other', artifactId: 'artifact-tape' }),
      issue({ id: 'lantern-note', artifactId: 'artifact-lantern' }),
    ], after);
    expect(scoped.map((candidate) => candidate.id)).toEqual(['tape-note']);
  });
});

describe('filterIssuesByStatus', () => {
  const issues = [
    issue({ id: 'a', status: 'open' }),
    issue({ id: 'b', status: 'in-progress' }),
    issue({ id: 'c', status: 'resolved' }),
  ];

  it('returns all findings for the all filter', () => {
    expect(filterIssuesByStatus(issues, 'all')).toHaveLength(3);
  });

  it('filters by a single status', () => {
    expect(filterIssuesByStatus(issues, 'resolved').map((candidate) => candidate.id)).toEqual(['c']);
    expect(filterIssuesByStatus(issues, 'open').map((candidate) => candidate.id)).toEqual(['a']);
  });
});

describe('countByStatus', () => {
  it('counts every tab including all', () => {
    const issues = [
      issue({ status: 'open' }),
      issue({ status: 'open' }),
      issue({ status: 'in-progress' }),
      issue({ status: 'resolved' }),
    ];
    expect(countByStatus(issues)).toEqual({ all: 4, open: 2, 'in-progress': 1, resolved: 1 });
  });

  it('reports zeros for an empty list', () => {
    expect(countByStatus([])).toEqual({ all: 0, open: 0, 'in-progress': 0, resolved: 0 });
  });
});
