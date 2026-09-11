import { analyzeJourney, getUnplacedArtifacts } from '../domain/journeyAnalysis';
import { issueProgress } from '../domain/reviewRules';
import type { Artifact, ReviewIssue, WorkspaceState, Zone } from '../domain/models';

export function selectArtifactById(state: WorkspaceState, id: string): Artifact | undefined {
  return state.artifacts.find((artifact) => artifact.id === id);
}

export function selectZoneById(state: WorkspaceState, id: string): Zone | undefined {
  return state.zones.find((zone) => zone.id === id);
}

export function selectArtifactZone(state: WorkspaceState, artifactId: string): Zone | undefined {
  return state.zones.find((zone) => zone.artifactIds.includes(artifactId));
}

export function selectArtifactsForZone(state: WorkspaceState, zoneId: string): Artifact[] {
  const zone = selectZoneById(state, zoneId);
  if (!zone) return [];
  const artifactById = new Map(state.artifacts.map((artifact) => [artifact.id, artifact]));
  return zone.artifactIds
    .map((id) => artifactById.get(id))
    .filter((artifact): artifact is Artifact => Boolean(artifact));
}

export function selectIssuesForZone(state: WorkspaceState, zoneId: string): ReviewIssue[] {
  return state.issues.filter((issue) => selectEffectiveIssueZone(state, issue)?.id === zoneId);
}

/**
 * Resolve the zone a finding currently concerns. Object-linked findings always
 * follow the object's live placement, so moving an object moves its history
 * instead of orphaning or deleting it; zone-only findings keep their link.
 */
export function selectEffectiveIssueZone(
  state: WorkspaceState,
  issue: Pick<ReviewIssue, 'zoneId' | 'artifactId'>,
): Zone | undefined {
  if (issue.artifactId) return selectArtifactZone(state, issue.artifactId);
  return issue.zoneId ? selectZoneById(state, issue.zoneId) : undefined;
}

export function selectWorkspaceSummary(state: WorkspaceState) {
  const analysis = analyzeJourney(state.artifacts, state.zones);
  return {
    analysis,
    unplacedArtifacts: getUnplacedArtifacts(state.artifacts, state.zones),
    issueProgress: issueProgress(state.issues),
    openIssues: state.issues.filter((issue) => issue.status !== 'resolved'),
    criticalIssues: state.issues.filter((issue) => issue.severity === 'critical' && issue.status !== 'resolved'),
  };
}
