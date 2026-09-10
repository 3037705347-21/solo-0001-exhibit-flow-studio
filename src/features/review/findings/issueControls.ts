import type { IssueStatus } from '../../../domain/models';

/** The single status the review desk offers from each current status. */
export function nextIssueStatus(status: IssueStatus): IssueStatus {
  if (status === 'open') return 'in-progress';
  if (status === 'in-progress') return 'resolved';
  return 'in-progress';
}

export function issueActionLabel(status: IssueStatus): string {
  if (status === 'open') return 'Start work';
  if (status === 'in-progress') return 'Resolve';
  return 'Reopen';
}
