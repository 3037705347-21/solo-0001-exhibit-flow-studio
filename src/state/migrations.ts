import { EMPTY_LINEAGE, artifactNodeId, findNode, reconcileLineage } from '../domain/lineage';
import type { LineageState, WorkspaceState } from '../domain/models';

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

interface LegacyWorkspace {
  version?: number;
  project?: WorkspaceState['project'];
  artifacts?: WorkspaceState['artifacts'];
  zones?: LegacyZone[];
  issues?: WorkspaceState['issues'];
  preferences?: WorkspaceState['preferences'];
  lineage?: LineageState;
  lastSavedAt?: string;
}

function isValidLineage(value: unknown): value is LineageState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<LineageState>;
  return Array.isArray(candidate.nodes) && Array.isArray(candidate.edges) && Array.isArray(candidate.batches);
}

export function migrateWorkspace(value: unknown): WorkspaceState | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as LegacyWorkspace;
  if (!source.project || !source.artifacts || !source.zones || !source.issues || !source.preferences) return null;
  const zones = source.zones.map((zone, index) => ({
    ...zone,
    sequence: typeof zone.sequence === 'number' ? zone.sequence : index,
  }));
  const lineage = isValidLineage(source.lineage) ? source.lineage : EMPTY_LINEAGE;
  return {
    version: 1,
    project: source.project,
    artifacts: source.artifacts,
    zones,
    issues: source.issues,
    preferences: source.preferences,
    lineage,
    lastSavedAt: source.lastSavedAt,
  };
}

/**
 * Reconcile lineage for workspaces created before provenance existed. Because
 * every node and edge has a deterministic id, running this on a workspace that
 * already has lineage is a no-op: importing the same file twice can never
 * regenerate relationships.
 */
export function ensureLineage(state: WorkspaceState): WorkspaceState {
  const hasStructuralLineage = state.lineage.nodes.some((node) => node.type === 'artifact');
  if (hasStructuralLineage) return state;
  return {
    ...state,
    lineage: reconcileLineage(state.lineage, state.artifacts, state.zones, state.issues, 'backfill'),
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
      // A finding may legitimately reference a deleted object when its
      // provenance node was retained and tombstoned: keep the link so the
      // review desk can show "source deleted — needs re-review".
      zoneId: issue.zoneId && zoneIds.has(issue.zoneId) ? issue.zoneId : undefined,
      artifactId: issue.artifactId && (
        artifactIds.has(issue.artifactId)
        || findNode(state.lineage, artifactNodeId(issue.artifactId))?.tombstoned
      ) ? issue.artifactId : undefined,
    })),
  };
}
