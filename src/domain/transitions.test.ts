import { describe, expect, it } from 'vitest';
import { TransitionError, transitionIssue } from './transitions';
import { issueFromInput } from './issueHistory';

const issue = issueFromInput('i', {
  title: 'Issue',
  description: 'Description long enough to be useful.',
  severity: 'critical',
  owner: 'Owner',
}, new Date('2026-01-01T00:00:00.000Z'));

describe('review transitions', () => {
  it('moves an issue through the allowed lifecycle', () => {
    const inProgress = transitionIssue(issue, 'in-progress');
    const resolved = transitionIssue(inProgress, 'resolved', new Date('2026-01-02T00:00:00.000Z'));
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedAt).toBe('2026-01-02T00:00:00.000Z');
  });
  it('rejects skipping the in-progress state', () => {
    expect(() => transitionIssue(issue, 'resolved')).toThrow(TransitionError);
  });
});
