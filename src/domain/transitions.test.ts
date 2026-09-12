import { describe, expect, it } from 'vitest';
import { TransitionError, transitionIssue } from './transitions';
import type { ReviewIssue } from './models';

const issue: ReviewIssue = { id: 'i', title: 'Issue', description: 'Description', severity: 'critical', status: 'open', owner: 'Owner', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', revision: 1 };

describe('review transitions', () => {
  it('moves an issue through the allowed lifecycle', () => {
    const inProgress = transitionIssue(issue, 'in-progress');
    const resolved = transitionIssue(inProgress, 'resolved', new Date('2026-01-02T00:00:00.000Z'));
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedAt).toBe('2026-01-02T00:00:00.000Z');
  });
  it('bumps the revision on every transition for optimistic concurrency', () => {
    const inProgress = transitionIssue(issue, 'in-progress');
    expect(inProgress.revision).toBe(2);
    expect(transitionIssue(inProgress, 'resolved').revision).toBe(3);
  });
  it('rejects skipping the in-progress state', () => {
    expect(() => transitionIssue(issue, 'resolved')).toThrow(TransitionError);
  });
});
