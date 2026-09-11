import type { PlanApproval, WorkspaceState } from '../domain/models';

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
  approval?: unknown;
  lastSavedAt?: string;
}

function isPlanApproval(value: unknown): value is PlanApproval {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PlanApproval>;
  return typeof candidate.approver === 'string'
    && typeof candidate.approvedAt === 'string'
    && typeof candidate.planVersion === 'string'
    && (candidate.status === 'active' || candidate.status === 'stale');
}

export function migrateWorkspace(value: unknown): WorkspaceState | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as LegacyWorkspace;
  if (!source.project || !source.artifacts || !source.zones || !source.issues || !source.preferences) return null;
  const zones = source.zones.map((zone, index) => ({
    ...zone,
    sequence: typeof zone.sequence === 'number' ? zone.sequence : index,
  }));
  return {
    version: 1,
    project: source.project,
    artifacts: source.artifacts,
    zones,
    issues: source.issues,
    preferences: source.preferences,
    // Pre-sign-off workspaces carry no approval. Only a well-formed record written
    // by the sign-off command is kept; a legacy ready project is never given a
    // fabricated one and must be confirmed again before publishing.
    approval: isPlanApproval(source.approval) ? source.approval : undefined,
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
  };
}
