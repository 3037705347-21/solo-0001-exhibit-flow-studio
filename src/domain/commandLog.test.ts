import { describe, expect, it } from 'vitest';
import {
  HISTORY_LIMIT,
  appendHistory,
  createHistoryEntry,
  describeAction,
  historyContextFromState,
  normalizeHistory,
  type HistoryEntry,
} from './commandLog';
import type { WorkspaceAction } from '../state/actions';
import { createSeedWorkspace } from '../state/seed';

const seed = createSeedWorkspace();
const context = historyContextFromState(seed);

function entry(id: string, action: WorkspaceAction, at = new Date('2026-09-01T10:00:00.000Z')): HistoryEntry {
  return createHistoryEntry(action, context, id, at);
}

describe('command history summaries', () => {
  it('describes adding and updating objects', () => {
    expect(describeAction({ type: 'artifact/upsert', artifact: seed.artifacts[0] }, context)).toContain('Updated object');

    const newArtifact = { ...seed.artifacts[0], id: 'artifact-new', accessionId: 'AF-2030-001', title: 'Fresh Find' };
    const addContext = { ...context, artifacts: context.artifacts.filter((artifact) => artifact.id !== newArtifact.id) };
    expect(describeAction({ type: 'artifact/upsert', artifact: newArtifact }, addContext)).toContain('Added object “Fresh Find” (AF-2030-001)');
  });

  it('names removed objects from pre-action state', () => {
    const summary = describeAction({ type: 'artifact/remove', artifactId: 'artifact-lantern' }, context);
    expect(summary).toBe('Removed object “Railway Signal Lantern” (AF-1908-014)');
  });

  it('distinguishes initial placement, re-zoning, and within-zone repositioning', () => {
    const unplaced = 'artifact-gloves';
    expect(describeAction({ type: 'placement/assign', artifactId: unplaced, zoneId: 'zone-arrival' }, context))
      .toBe('Placed “Conservator’s Gloves” (AF-2001-019) in Arrival / A Light Carried');

    expect(describeAction({ type: 'placement/assign', artifactId: 'artifact-lantern', zoneId: 'zone-patterns' }, context))
      .toBe('Moved “Railway Signal Lantern” (AF-1908-014) from Arrival / A Light Carried to Patterns of Work');

    expect(describeAction({ type: 'placement/assign', artifactId: 'artifact-radio', zoneId: 'zone-patterns' }, context))
      .toContain('Repositioned “Kitchen Table Radio”');

    expect(describeAction({ type: 'placement/remove', artifactId: 'artifact-lantern' }, context))
      .toBe('Removed “Railway Signal Lantern” (AF-1908-014) from the journey');
  });

  it('describes reorder direction and zone', () => {
    expect(describeAction({ type: 'placement/reorder', zoneId: 'zone-patterns', artifactId: 'artifact-radio', direction: 1 }, context))
      .toBe('Moved “Kitchen Table Radio” (AF-1968-117) later in Patterns of Work');
    expect(describeAction({ type: 'placement/reorder', zoneId: 'zone-patterns', artifactId: 'artifact-sample-book', direction: -1 }, context))
      .toBe('Moved “Dyer’s Sample Book” (AF-1926-203) earlier in Patterns of Work');
  });

  it('describes finding lifecycle from pre-action state', () => {
    expect(describeAction({ type: 'issue/add', issue: seed.issues[0] }, context))
      .toBe('Created Critical finding “Add transcript beside oral history station”');
    expect(describeAction({ type: 'issue/transition', issueId: 'issue-entry-copy', status: 'in-progress' }, context))
      .toBe('Started work on finding “Reduce entry panel copy”');
    expect(describeAction({ type: 'issue/transition', issueId: 'issue-entry-copy', status: 'resolved' }, context))
      .toBe('Resolved finding “Reduce entry panel copy”');
    expect(describeAction({ type: 'issue/transition', issueId: 'issue-quilt-light', status: 'open' }, context))
      .toBe('Reopened finding “Confirm quilt lux rotation”');
  });

  it('describes preferences, readiness, and reset commands', () => {
    expect(describeAction({ type: 'preferences/update', preferences: { pace: 'leisurely', accessibilityPriority: 80, groupSize: 12 } }, context))
      .toBe('Applied visitor preferences: Leisurely pace, group 12, access priority 80%');
    expect(describeAction({ type: 'project/readiness', ready: true, checkedAt: '2026-09-01T10:00:00.000Z' }, context)).toContain('marked ready');
    expect(describeAction({ type: 'project/readiness', ready: false, checkedAt: '2026-09-01T10:00:00.000Z' }, context)).toContain('returned to review');
    expect(describeAction({ type: 'workspace/reset', state: seed }, context)).toBe('Reset workspace to the sample plan');
  });

  it('tags every entry with a source, category, timestamp, and actor', () => {
    const created = entry('event-1', { type: 'workspace/reset', state: seed });
    expect(created).toMatchObject({
      id: 'event-1',
      category: 'workspace',
      source: 'Workspace',
      action: 'workspace/reset',
      actor: 'local-user',
    });
    expect(Number.isNaN(new Date(created.timestamp).getTime())).toBe(false);
  });
});

describe('appendHistory', () => {
  it('keeps chronological order', () => {
    const first = entry('event-1', { type: 'placement/remove', artifactId: 'artifact-lantern' });
    const second = entry('event-2', { type: 'placement/remove', artifactId: 'artifact-radio' });
    expect(appendHistory([first], second).map((item) => item.id)).toEqual(['event-1', 'event-2']);
  });

  it('caps growth and drops the oldest entries', () => {
    const base: HistoryEntry[] = Array.from({ length: HISTORY_LIMIT }, (_, index) =>
      entry(`event-${index}`, { type: 'placement/remove', artifactId: 'artifact-lantern' }, new Date(2026, 0, index + 1)));
    const incoming = entry('event-latest', { type: 'workspace/reset', state: seed }, new Date(2027, 0, 1));
    const result = appendHistory(base, incoming);
    expect(result).toHaveLength(HISTORY_LIMIT);
    expect(result[0].id).toBe('event-1');
    expect(result[result.length - 1].id).toBe('event-latest');
  });

  it('honours a custom limit for small-history scenarios', () => {
    const base: HistoryEntry[] = Array.from({ length: 3 }, (_, index) =>
      entry(`event-${index}`, { type: 'placement/remove', artifactId: 'artifact-lantern' }));
    const result = appendHistory(base, entry('event-3', { type: 'workspace/reset', state: seed }), 2);
    expect(result.map((item) => item.id)).toEqual(['event-2', 'event-3']);
  });
});

describe('normalizeHistory', () => {
  it('returns an empty list for malformed storage', () => {
    expect(normalizeHistory(null)).toEqual([]);
    expect(normalizeHistory({})).toEqual([]);
    expect(normalizeHistory('nope')).toEqual([]);
  });

  it('drops malformed entries but keeps valid ones', () => {
    const good = entry('event-good', { type: 'workspace/reset', state: seed });
    const result = normalizeHistory([
      good,
      { id: '', summary: 'Missing id', action: 'workspace/reset', timestamp: '2026-09-01T10:00:00.000Z', source: 'Workspace', category: 'workspace' },
      { id: 'event-bad-date', summary: 'Bad date', action: 'workspace/reset', timestamp: 'not-a-date', source: 'Workspace', category: 'workspace' },
      { id: 'event-bad-action', summary: 'Bad action', action: 'something/else', timestamp: '2026-09-01T10:00:00.000Z', source: 'Workspace', category: 'workspace' },
      'totally invalid',
    ]);
    expect(result.map((item) => item.id)).toEqual(['event-good']);
  });

  it('coerces unknown actors to local-user and applies the cap on load', () => {
    const entries: unknown[] = Array.from({ length: HISTORY_LIMIT + 12 }, (_, index) => ({
      id: `event-${index}`,
      category: 'workspace',
      action: 'workspace/reset',
      summary: `Reset ${index}`,
      source: 'Workspace',
      timestamp: new Date(2026, 0, index + 1).toISOString(),
      actor: index % 2 ? 'system' : 'mystery',
    }));
    const result = normalizeHistory(entries);
    expect(result).toHaveLength(HISTORY_LIMIT);
    expect(result[0].id).toBe('event-12');
    expect(result.every((item) => item.actor === 'system' || item.actor === 'local-user')).toBe(true);
    expect(result.find((item) => item.id === 'event-12')?.actor).toBe('local-user');
    expect(result.find((item) => item.id === 'event-13')?.actor).toBe('system');
  });
});
