import { describe, expect, it } from 'vitest';
import { commitMerge, prepareMerge } from '../domain/mergeIssues';
import type { ReviewIssue } from '../domain/models';
import { workspaceReducer } from './reducer';
import { createSeedWorkspace } from './seed';

function makeIssue(overrides: Partial<ReviewIssue> & Pick<ReviewIssue, 'id' | 'title'>): ReviewIssue {
  return {
    description: 'Enough context for a review finding used in tests.',
    severity: 'warning',
    status: 'open',
    owner: 'Jo Renner',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

function mergedAction(ids: string[]) {
  const seed = createSeedWorkspace();
  const state = { ...seed, issues: [...seed.issues, makeIssue({ id: ids[0], title: 'First duplicate' }), makeIssue({ id: ids[1], title: 'Second duplicate' })] };
  const preview = prepareMerge(state, ids);
  if (!preview.ok) throw new Error(preview.message);
  const result = commitMerge(state, {
    sourceIds: ids,
    reason: 'Same problem reported from object and checklist views.',
    expectedFingerprint: preview.preview.fingerprint,
    at: new Date('2026-09-10T10:00:00.000Z'),
    idFactory: () => 'issue-canonical-reducer',
  });
  if (!result.ok) throw new Error(result.message);
  return { state, action: { type: 'issue/merge', canonical: result.canonical, sources: result.sources } as const };
}

describe('issue/merge reducer', () => {
  it('inserts the canonical record and marks the sources in one transaction', () => {
    const { state, action } = mergedAction(['merge-a', 'merge-b']);
    const next = workspaceReducer(state, action);

    const canonical = next.issues.find((issue) => issue.id === 'issue-canonical-reducer');
    expect(canonical?.merge?.mergedFrom.sort()).toEqual(['merge-a', 'merge-b']);
    expect(next.issues.find((issue) => issue.id === 'merge-a')?.mergedIntoId).toBe(canonical?.id);
    expect(next.issues.find((issue) => issue.id === 'merge-b')?.mergedIntoId).toBe(canonical?.id);
    expect(next.issues).toHaveLength(state.issues.length + 1);
  });

  it('is idempotent when the same merge action is applied twice', () => {
    const { state, action } = mergedAction(['merge-a', 'merge-b']);
    const once = workspaceReducer(state, action);
    const twice = workspaceReducer(once, action);

    expect(twice.issues.filter((issue) => issue.id === 'issue-canonical-reducer')).toHaveLength(1);
    expect(twice.issues).toHaveLength(once.issues.length);
  });

  it('regresses a ready project back to review when a merge lands', () => {
    const { state, action } = mergedAction(['merge-a', 'merge-b']);
    const ready = { ...state, project: { ...state.project, stage: 'ready' as const } };
    const next = workspaceReducer(ready, action);
    expect(next.project.stage).toBe('review');
  });
});
