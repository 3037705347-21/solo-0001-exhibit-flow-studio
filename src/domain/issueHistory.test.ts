import { describe, expect, it } from 'vitest';
import {
  IssueHistoryError,
  backfillIssueHistory,
  canTransitionStatus,
  isReconciled,
  issueFromInput,
  projectIssue,
  reconcileIssue,
  recordIssueEdit,
  recordIssueReassignment,
  recordIssueStatus,
  sortEvents,
  summarizeHistory,
} from './issueHistory';
import type { ReviewIssue } from './models';

const t1 = new Date('2026-09-02T09:00:00.000Z');
const t2 = new Date('2026-09-02T11:00:00.000Z');
const t3 = new Date('2026-09-03T10:00:00.000Z');
const t4 = new Date('2026-09-04T08:30:00.000Z');
const t5 = new Date('2026-09-05T15:00:00.000Z');
const t6 = new Date('2026-09-06T09:15:00.000Z');

function newIssue(): ReviewIssue {
  return issueFromInput('issue-x', {
    title: 'Label too high for wheelchair eye line',
    description: 'The zone label sits above the comfortable seated viewing angle.',
    severity: 'critical',
    owner: 'Mara Chen',
    zoneId: 'zone-after',
  }, t1);
}

describe('issue decision history', () => {
  it('records a created event that fully explains the initial open state', () => {
    const issue = newIssue();
    expect(issue.status).toBe('open');
    expect(issue.events).toHaveLength(1);
    expect(issue.events[0].type).toBe('created');
    expect(issue.events[0].seq).toBe(1);
    expect(issue.createdAt).toBe(t1.toISOString());

    const projection = projectIssue(issue);
    expect(projection).toMatchObject({
      title: issue.title,
      description: issue.description,
      severity: 'critical',
      owner: 'Mara Chen',
      status: 'open',
      zoneId: 'zone-after',
    });
    expect(projection?.resolvedAt).toBeUndefined();
  });

  it('appends chronological, monotonically sequenced events for a full lifecycle', () => {
    const issue = [
      (i: ReviewIssue) => recordIssueStatus(i, 'in-progress', t2, 'Mara Chen', 'Picking up the remount.'),
      (i: ReviewIssue) => recordIssueStatus(i, 'resolved', t3, 'Mara Chen', 'Remounted at 1200mm.'),
      (i: ReviewIssue) => recordIssueStatus(i, 'open', t4, 'Theo James', 'Lighting review found glare.'),
      (i: ReviewIssue) => recordIssueStatus(i, 'in-progress', t5, 'Theo James'),
      (i: ReviewIssue) => recordIssueReassignment(i, 'Rina Solberg', t5, 'Theo James', 'Conservation owns the fix now.'),
      (i: ReviewIssue) => recordIssueStatus(i, 'resolved', t6, 'Rina Solberg', 'Anti-glare film applied.'),
    ].reduce((current, step) => step(current), newIssue());

    const types = sortEvents(issue.events).map((event) => event.type);
    expect(types).toEqual(['created', 'started', 'resolved', 'reopened', 'started', 'reassigned', 'resolved']);
    expect(issue.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(issue.status).toBe('resolved');
    expect(issue.owner).toBe('Rina Solberg');
    expect(issue.resolvedAt).toBe(t6.toISOString());
    expect(issue.updatedAt).toBe(t6.toISOString());
  });

  it('reopening clears the current resolvedAt so an old resolution cannot pass as current', () => {
    let issue = recordIssueStatus(newIssue(), 'in-progress', t2);
    issue = recordIssueStatus(issue, 'resolved', t3, undefined, 'First fix.');
    expect(issue.resolvedAt).toBe(t3.toISOString());
    issue = recordIssueStatus(issue, 'open', t4, undefined, 'Fix regressed.');
    expect(issue.status).toBe('open');
    expect(issue.resolvedAt).toBeUndefined();

    const resolutions = issue.events.filter((event) => event.type === 'resolved');
    expect(resolutions).toHaveLength(1);
    expect(summarizeHistory(issue)).toMatchObject({ reopenCount: 1, resolutionCount: 1 });
  });

  it('rejects illegal lifecycle jumps with an explanatory error', () => {
    expect(() => recordIssueStatus(newIssue(), 'resolved', t2)).toThrow(IssueHistoryError);
    const started = recordIssueStatus(newIssue(), 'in-progress', t2);
    expect(() => recordIssueStatus(started, 'open', t3)).not.toThrow();
    expect(canTransitionStatus('resolved', 'resolved')).toBe(false);
  });

  it('treats a same-status transition as a no-op and appends no event', () => {
    const issue = newIssue();
    const again = recordIssueStatus(issue, 'open', t2);
    expect(again).toBe(issue);
    expect(issue.events).toHaveLength(1);
  });

  it('records edits containing only changed fields and never overwrites earlier events', () => {
    const original = newIssue();
    const edited = recordIssueEdit(original, { title: 'New title', severity: 'warning', description: original.description }, t2);
    expect(edited.title).toBe('New title');
    expect(edited.severity).toBe('warning');
    expect(edited.events).toHaveLength(2);
    expect(edited.events[1].type).toBe('edited');
    expect(edited.events[1].snapshot).toEqual({ title: 'New title', severity: 'warning' });

    // The original event chain is untouched.
    expect(original.events).toHaveLength(1);
    expect(original.title).toBe('Label too high for wheelchair eye line');

    // A patch without real changes appends nothing.
    const noop = recordIssueEdit(edited, { title: 'New title' }, t3);
    expect(noop).toBe(edited);

    // Removing links is an explicit recorded change.
    const unlinked = recordIssueEdit(edited, { zoneId: '', artifactId: '' }, t4);
    expect(unlinked.zoneId).toBeUndefined();
    expect(unlinked.artifactId).toBeUndefined();
  });

  it('records reassignments and ignores same-owner reassignment', () => {
    const moved = recordIssueReassignment(newIssue(), 'Rina Solberg', t2, 'Mara Chen', 'Handover.');
    expect(moved.owner).toBe('Rina Solberg');
    expect(moved.events.at(-1)).toMatchObject({ type: 'reassigned', owner: 'Rina Solberg', actor: 'Mara Chen' });
    const same = recordIssueReassignment(moved, 'Rina Solberg', t3);
    expect(same).toBe(moved);
  });

  it('derives current state purely from the event chain after repeated operations', () => {
    let issue = newIssue();
    issue = recordIssueEdit(issue, { title: 'Second title' }, t2);
    issue = recordIssueReassignment(issue, 'Theo James', t3);
    issue = recordIssueStatus(issue, 'in-progress', t4);
    issue = recordIssueStatus(issue, 'resolved', t5, undefined, 'Done once.');
    issue = recordIssueStatus(issue, 'open', t6, undefined, 'Needs more work.');

    const rebuilt = reconcileIssue({ ...issue, title: 'tampered', status: 'resolved', resolvedAt: t5.toISOString(), owner: 'someone' });
    expect(rebuilt).not.toBeNull();
    expect(rebuilt?.title).toBe('Second title');
    expect(rebuilt?.status).toBe('open');
    expect(rebuilt?.resolvedAt).toBeUndefined();
    expect(rebuilt?.owner).toBe('Theo James');
    expect(isReconciled(rebuilt as ReviewIssue)).toBe(true);
  });
});

describe('legacy finding backfill', () => {
  it('synthesizes one compatible initial record for each legacy status', () => {
    for (const status of ['open', 'in-progress', 'resolved'] as const) {
      const legacy: ReviewIssue = {
        id: `legacy-${status}`,
        title: 'Legacy finding',
        description: 'Created before decision history existed and needs migration.',
        severity: 'warning',
        status,
        zoneId: 'zone-arrival',
        owner: 'Theo James',
        createdAt: '2026-08-01T08:00:00.000Z',
        updatedAt: '2026-08-10T08:00:00.000Z',
        ...(status === 'resolved' ? { resolvedAt: '2026-08-10T08:00:00.000Z' } : {}),
        events: [],
      };
      const migrated = reconcileIssue(backfillIssueHistory(legacy));
      expect(migrated).not.toBeNull();
      expect(migrated!.events).toHaveLength(1);
      expect(migrated!.events[0]).toMatchObject({ type: 'created', backfilled: true });
      expect(migrated!.status).toBe(status);
      expect(projectIssue(migrated!)?.status).toBe(status);
      // Legacy timestamps are retained for migrated single-event chains.
      expect(migrated!.updatedAt).toBe('2026-08-10T08:00:00.000Z');
      if (status === 'resolved') expect(migrated!.resolvedAt).toBe('2026-08-10T08:00:00.000Z');
      else expect(migrated!.resolvedAt).toBeUndefined();
    }
  });

  it('never backfills a finding that already has history', () => {
    const issue = newIssue();
    expect(backfillIssueHistory(issue)).toBe(issue);
  });
});
