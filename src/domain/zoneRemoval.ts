import type { Artifact, ReviewIssue, WorkspaceState, Zone } from './models';

export interface ZoneDeleteImpact {
  zone: Zone;
  objects: Artifact[];
  zoneFindings: ReviewIssue[];
  objectFindings: ReviewIssue[];
}

export function planZoneDelete(state: WorkspaceState, zoneId: string): ZoneDeleteImpact | null {
  const zone = state.zones.find((candidate) => candidate.id === zoneId);
  if (!zone) return null;
  const artifactById = new Map(state.artifacts.map((artifact) => [artifact.id, artifact]));
  const objects = zone.artifactIds
    .map((id) => artifactById.get(id))
    .filter((artifact): artifact is Artifact => Boolean(artifact));
  const linked = state.issues.filter((issue) => issue.zoneId === zoneId);
  return {
    zone,
    objects,
    zoneFindings: linked.filter((issue) => !issue.artifactId),
    // Findings with an object link keep their object link after the zone disappears,
    // even when the object currently lives in a different zone.
    objectFindings: linked.filter((issue) => Boolean(issue.artifactId)),
  };
}
