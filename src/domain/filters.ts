import type { Artifact, IssueSeverity, IssueStatus, ReviewIssue, Zone } from './models';

export interface CollectionFilter {
  query: string;
  roles: string[];
  sensitivities: string[];
  keyOnly: boolean;
  minDwell?: number;
  maxDwell?: number;
}
export interface IssueFilter {
  statuses: IssueStatus[];
  severities: IssueSeverity[];
  zoneId?: string;
  owner?: string;
}

export function filterCollection(artifacts: Artifact[], filter: CollectionFilter): Artifact[] {
  const query = filter.query.trim().toLowerCase();
  return artifacts.filter((artifact) => {
    const text = [
      artifact.title,
      artifact.maker,
      artifact.accessionId,
      artifact.medium,
      artifact.origin,
      artifact.summary,
      ...artifact.tags,
    ]
      .join(' ')
      .toLowerCase();
    const queryMatch = !query || text.includes(query);
    const roleMatch = !filter.roles.length || filter.roles.includes(artifact.narrativeRole);
    const sensitivityMatch =
      !filter.sensitivities.length || filter.sensitivities.includes(artifact.sensitivity);
    const keyMatch = !filter.keyOnly || artifact.isKeyObject;
    const minMatch = filter.minDwell === undefined || artifact.dwellMinutes >= filter.minDwell;
    const maxMatch = filter.maxDwell === undefined || artifact.dwellMinutes <= filter.maxDwell;
    return queryMatch && roleMatch && sensitivityMatch && keyMatch && minMatch && maxMatch;
  });
}

export function filterIssues(issues: ReviewIssue[], filter: IssueFilter): ReviewIssue[] {
  return issues.filter(
    (issue) =>
      (!filter.statuses.length || filter.statuses.includes(issue.status)) &&
      (!filter.severities.length || filter.severities.includes(issue.severity)) &&
      (!filter.zoneId || issue.zoneId === filter.zoneId) &&
      (!filter.owner || issue.owner.toLowerCase().includes(filter.owner.toLowerCase())),
  );
}

export function sortZones(zones: Zone[], direction: 'asc' | 'desc' = 'asc'): Zone[] {
  const multiplier = direction === 'asc' ? 1 : -1;
  return [...zones].sort((left, right) => multiplier * (left.sequence - right.sequence));
}

export function countPlaced(artifact: Artifact, zones: Zone[]): number {
  return zones.filter((zone) => zone.artifactIds.includes(artifact.id)).length;
}
