import type { IssueStatus, ReviewIssue, Zone } from '../../../domain/models';

export type StatusFilter = IssueStatus | 'all';

export const STATUS_FILTERS: StatusFilter[] = ['all', 'open', 'in-progress', 'resolved'];

/**
 * A finding belongs to a zone when it is linked to the zone directly, or when
 * it is attached to an object placed in the zone (regardless of its own zone
 * link — findings can surface in both scopes).
 */
export function isIssueInZone(issue: ReviewIssue, zone: Zone): boolean {
  return issue.zoneId === zone.id
    || (Boolean(issue.artifactId) && zone.artifactIds.includes(issue.artifactId as string));
}

/** Returns every finding visible in a zone; without a zone the full list passes through (overview). */
export function scopeIssuesToZone(issues: ReviewIssue[], zone?: Zone | null): ReviewIssue[] {
  if (!zone) return issues;
  return issues.filter((issue) => isIssueInZone(issue, zone));
}

export function filterIssuesByStatus(issues: ReviewIssue[], status: StatusFilter): ReviewIssue[] {
  return status === 'all' ? issues : issues.filter((issue) => issue.status === status);
}

export type IssueStatusCounts = Record<StatusFilter, number>;

export function countByStatus(issues: ReviewIssue[]): IssueStatusCounts {
  return {
    all: issues.length,
    open: issues.filter((issue) => issue.status === 'open').length,
    'in-progress': issues.filter((issue) => issue.status === 'in-progress').length,
    resolved: issues.filter((issue) => issue.status === 'resolved').length,
  };
}
