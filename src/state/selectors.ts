import { analyzeJourney, getUnplacedArtifacts } from '../domain/journeyAnalysis';
import { artifactDeleteImpact, artifactNodeId, findNode } from '../domain/lineage';
import type { DeleteImpact } from '../domain/lineage';
import { artifactLineage, issueLineage, placementLineage } from '../domain/lineageView';
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
  return state.issues.filter((issue) => issue.zoneId === zoneId);
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

export function selectArtifactLineage(state: WorkspaceState, artifactId: string) {
  return artifactLineage(state, artifactId);
}

export function selectPlacementLineage(state: WorkspaceState, artifactId: string) {
  return placementLineage(state, artifactId);
}

export function selectIssueLineage(state: WorkspaceState, issueId: string) {
  return issueLineage(state, issueId);
}

export function selectArtifactDeleteImpact(state: WorkspaceState, artifactId: string): DeleteImpact {
  return artifactDeleteImpact(state.lineage, artifactId);
}

export function selectRecordNeedsReview(state: WorkspaceState, nodeId: string): boolean {
  const node = findNode(state.lineage, nodeId);
  return Boolean(node?.staleReason);
}

export function selectArtifactNodeHealth(state: WorkspaceState, artifactId: string) {
  const node = findNode(state.lineage, artifactNodeId(artifactId));
  return {
    staleReason: node?.staleReason,
    tombstoned: node?.tombstoned ?? false,
    origin: node?.origin,
    batchFileName: node?.batchFileName,
  };
}

/** Published package nodes, newest first, with current dependency health. */
export function selectPublishedSnapshots(state: WorkspaceState) {
  return state.lineage.nodes
    .filter((node) => node.type === 'snapshot')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
