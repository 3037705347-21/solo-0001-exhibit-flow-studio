import { describe, expect, it } from 'vitest';
import { buildCreationRevision, buildStatusRevision, prepareIssueEdit, type IssueEditInput } from '../domain/issueRevisions';
import { transitionIssue } from '../domain/transitions';
import type { IssueDraft, ReviewIssue } from '../domain/models';
import { workspaceReducer } from './reducer';
import { createSeedWorkspace } from './seed';

function draftOf(issue: ReviewIssue, overrides: Partial<IssueDraft> = {}): IssueDraft {
  return {
    title: issue.title,
    description: issue.description,
    severity: issue.severity,
    owner: issue.owner,
    zoneId: issue.zoneId ?? '',
    artifactId: issue.artifactId ?? '',
    ...overrides,
  };
}

function editInput(issue: ReviewIssue, draft: IssueDraft): IssueEditInput {
  return { issueId: issue.id, base: issue, draft, editor: 'Jo Renner', rationale: 'Walkthrough follow-up.' };
}

describe('workspace reducer issue revisions', () => {
  it('appends a creation revision when a finding is added', () => {
    const state = createSeedWorkspace();
    const issue: ReviewIssue = {
      id: 'issue-new',
      title: 'Check bench clearance',
      description: 'Confirm the bench keeps the accessible route clear.',
      severity: 'warning',
      status: 'open',
      owner: 'Jo Renner',
      version: 1,
      createdAt: '2026-09-12T09:00:00.000Z',
      updatedAt: '2026-09-12T09:00:00.000Z',
    };
    const next = workspaceReducer(state, { type: 'issue/add', issue, revision: buildCreationRevision(issue) });
    expect(next.issues[0].id).toBe('issue-new');
    expect(next.issueHistory).toHaveLength(state.issueHistory.length + 1);
    expect(next.issueHistory.at(-1)?.kind).toBe('create');
    expect(next.issueHistory.at(-1)?.resultVersion).toBe(1);
  });

  it('applies a committed edit and appends its revision without touching earlier history', () => {
    const state = createSeedWorkspace();
    const base = state.issues.find((issue) => issue.id === 'issue-entry-copy')!;
    const result = prepareIssueEdit(base, editInput(base, draftOf(base, { title: 'Shorten entry panel copy' })));
    if (result.kind !== 'committed') throw new Error('expected a committed edit');
    const historyBefore = state.issueHistory;
    const next = workspaceReducer(state, { type: 'issue/revise', issue: result.issue, revision: result.revision });
    const updated = next.issues.find((issue) => issue.id === base.id)!;
    expect(updated.title).toBe('Shorten entry panel copy');
    expect(updated.version).toBe(base.version + 1);
    // History is append-only: every earlier entry is preserved in order.
    expect(next.issueHistory.slice(0, historyBefore.length)).toEqual(historyBefore);
    expect(next.issueHistory).toHaveLength(historyBefore.length + 1);
    const revision = next.issueHistory.at(-1)!;
    expect(revision.kind).toBe('edit');
    expect(revision.baseVersion).toBe(base.version);
    expect(revision.changes).toEqual([{ field: 'title', before: 'Reduce entry panel copy', after: 'Shorten entry panel copy' }]);
  });

  it('records a status transition as a revision with a version bump', () => {
    const state = createSeedWorkspace();
    const issue = state.issues.find((candidate) => candidate.id === 'issue-entry-copy')!;
    const transitioned = transitionIssue(issue, 'in-progress');
    const next = workspaceReducer(state, {
      type: 'issue/transition',
      issue: transitioned,
      revision: buildStatusRevision(issue, transitioned),
    });
    const updated = next.issues.find((candidate) => candidate.id === issue.id)!;
    expect(updated.status).toBe('in-progress');
    expect(updated.version).toBe(issue.version + 1);
    const revision = next.issueHistory.at(-1)!;
    expect(revision.kind).toBe('status');
    expect(revision.changes).toEqual([{ field: 'status', before: 'open', after: 'in-progress' }]);
  });

  it('keeps the full history across repeated edits', () => {
    let state = createSeedWorkspace();
    const first = state.issues.find((issue) => issue.id === 'issue-entry-copy')!;
    const editOne = prepareIssueEdit(first, editInput(first, draftOf(first, { title: 'Shorten entry panel copy' })));
    if (editOne.kind !== 'committed') throw new Error('expected commit');
    state = workspaceReducer(state, { type: 'issue/revise', issue: editOne.issue, revision: editOne.revision });
    const second = state.issues.find((issue) => issue.id === 'issue-entry-copy')!;
    const editTwo = prepareIssueEdit(second, editInput(second, draftOf(second, { owner: 'Rina Solberg' })));
    if (editTwo.kind !== 'committed') throw new Error('expected commit');
    state = workspaceReducer(state, { type: 'issue/revise', issue: editTwo.issue, revision: editTwo.revision });
    const revisions = state.issueHistory.filter((revision) => revision.issueId === 'issue-entry-copy');
    expect(revisions.map((revision) => revision.resultVersion)).toEqual([1, 2, 3]);
    expect(revisions[0].changes.some((change) => change.after === 'Reduce entry panel copy')).toBe(true);
    expect(revisions[1].changes).toEqual([{ field: 'title', before: 'Reduce entry panel copy', after: 'Shorten entry panel copy' }]);
    expect(revisions[2].changes).toEqual([{ field: 'owner', before: 'Theo James', after: 'Rina Solberg' }]);
  });
});
