import { describe, expect, it } from 'vitest';
import { issueActionLabel, nextIssueStatus } from './issueControls';

describe('nextIssueStatus', () => {
  it('moves open findings to in-progress', () => {
    expect(nextIssueStatus('open')).toBe('in-progress');
  });

  it('resolves in-progress findings', () => {
    expect(nextIssueStatus('in-progress')).toBe('resolved');
  });

  it('reopens resolved findings back to in-progress', () => {
    expect(nextIssueStatus('resolved')).toBe('in-progress');
  });
});

describe('issueActionLabel', () => {
  it('uses the review desk button wording for each status', () => {
    expect(issueActionLabel('open')).toBe('Start work');
    expect(issueActionLabel('in-progress')).toBe('Resolve');
    expect(issueActionLabel('resolved')).toBe('Reopen');
  });
});
