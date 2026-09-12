import type { Artifact, ArtifactRevision, WorkspaceState } from '../domain/models';
import { createRevisionEntry } from '../domain/revisions';

interface LegacyZone {
  id: string;
  name: string;
  shortLabel: string;
  thesis: string;
  capacityMinutes: number;
  maxObjects: number;
  lowLight: boolean;
  hasSeating: boolean;
  color: string;
  sequence?: number;
  artifactIds: string[];
}

type LegacyArtifact = Omit<Artifact, 'revision'> & { revision?: number };

interface LegacyWorkspace {
  version?: number;
  project?: WorkspaceState['project'];
  artifacts?: LegacyArtifact[];
  zones?: LegacyZone[];
  issues?: WorkspaceState['issues'];
  revisions?: WorkspaceState['revisions'];
  preferences?: WorkspaceState['preferences'];
  lastSavedAt?: string;
}

/**
 * Guarantees every artifact has a version stamp and at least one revision
 * entry, so workspaces saved before the revision chain existed still present
 * a complete history after upgrade.
 */
function ensureRevisionChain(artifacts: Artifact[], revisions: ArtifactRevision[]): ArtifactRevision[] {
  const covered = new Set(revisions.map((revision) => revision.artifactId));
  const baseline = artifacts
    .filter((artifact) => !covered.has(artifact.id))
    .map((artifact) => createRevisionEntry({
      artifactId: artifact.id,
      after: artifact,
      kind: 'create',
      reason: 'Baseline record preserved during workspace upgrade.',
      at: new Date(artifact.createdAt),
      id: `revision-${artifact.id}-v${artifact.revision}`,
    }));
  return [...revisions, ...baseline];
}

export function migrateWorkspace(value: unknown): WorkspaceState | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as LegacyWorkspace;
  if (!source.project || !source.artifacts || !source.zones || !source.issues || !source.preferences) return null;
  const zones = source.zones.map((zone, index) => ({
    ...zone,
    sequence: typeof zone.sequence === 'number' ? zone.sequence : index,
  }));
  const artifacts = source.artifacts.map((artifact) => ({
    ...artifact,
    revision: typeof artifact.revision === 'number' ? artifact.revision : 1,
  }));
  const revisions = ensureRevisionChain(artifacts, Array.isArray(source.revisions) ? source.revisions : []);
  return {
    version: 1,
    project: source.project,
    artifacts,
    zones,
    issues: source.issues,
    revisions,
    preferences: source.preferences,
    lastSavedAt: source.lastSavedAt,
  };
}

export function validateReferences(state: WorkspaceState): WorkspaceState {
  const artifactIds = new Set(state.artifacts.map((artifact) => artifact.id));
  const zoneIds = new Set(state.zones.map((zone) => zone.id));
  return {
    ...state,
    zones: state.zones.map((zone) => ({ ...zone, artifactIds: zone.artifactIds.filter((id) => artifactIds.has(id)) })),
    issues: state.issues.map((issue) => ({
      ...issue,
      zoneId: issue.zoneId && zoneIds.has(issue.zoneId) ? issue.zoneId : undefined,
      artifactId: issue.artifactId && artifactIds.has(issue.artifactId) ? issue.artifactId : undefined,
    })),
    revisions: state.revisions.filter((revision) => artifactIds.has(revision.artifactId)),
  };
}
