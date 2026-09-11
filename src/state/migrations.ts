import { backfillIssueHistory, reconcileIssue, recordIssueEdit } from '../domain/issueHistory';
import type { WorkspaceState } from '../domain/models';

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
  lastSavedAt?: string;
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
    lastSavedAt: source.lastSavedAt,
  };
}

export function validateReferences(state: WorkspaceState): WorkspaceState {
  const artifactIds = new Set(state.artifacts.map((artifact) => artifact.id));
  const zoneIds = new Set(state.zones.map((zone) => zone.id));
  return {
    ...state,
    zones: state.zones.map((zone) => ({ ...zone, artifactIds: zone.artifactIds.filter((id) => artifactIds.has(id)) })),
    issues: state.issues
      // Findings created before event history receive one synthetic initial
      // record so their current state is explainable from the chain.
      .map((issue) => backfillIssueHistory(issue))
      // Reference cleanup is a real decision-record edit: the link no longer
      // resolves, so it is appended to the chain instead of silently mutated.
      // After the first migration load links are already clear, so this is a
      // no-op on subsequent loads.
      .map((issue) => recordIssueEdit(
        issue,
        {
          ...(issue.zoneId && !zoneIds.has(issue.zoneId) ? { zoneId: '' } : {}),
          ...(issue.artifactId && !artifactIds.has(issue.artifactId) ? { artifactId: '' } : {}),
        },
        new Date(),
        'system',
        'Dropped link to a zone or object that no longer exists.',
      ))
      // Rebuild denormalized fields from the immutable chain.
      .map((issue) => reconcileIssue(issue))
      .filter((issue): issue is NonNullable<typeof issue> => Boolean(issue)),
  };
}
