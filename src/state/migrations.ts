import type { ScenarioRecord, WorkspaceState } from '../domain/models';

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
  scenarioRecords?: unknown;
  lastSavedAt?: string;
}

function sanitizeScenarioRecords(value: unknown): ScenarioRecord[] {
  if (!Array.isArray(value)) return [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const records: ScenarioRecord[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Partial<ScenarioRecord>;
    if (
      typeof candidate.id !== 'string'
      || typeof candidate.name !== 'string'
      || !candidate.input
      || typeof candidate.planVersion !== 'string'
      || !candidate.planBasis
      || !candidate.projection
      || typeof candidate.createdAt !== 'string'
    ) {
      continue;
    }
    if (seenIds.has(candidate.id) || seenNames.has(candidate.name.toLowerCase())) continue;
    seenIds.add(candidate.id);
    seenNames.add(candidate.name.toLowerCase());
    records.push(candidate as ScenarioRecord);
  }
  return records;
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
    scenarioRecords: sanitizeScenarioRecords(source.scenarioRecords),
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
