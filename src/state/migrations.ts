import type { WorkspaceState, Zone } from '../domain/models';

interface LegacyZone {
  id: string;
  name?: string;
  shortLabel?: string;
  thesis?: string;
  capacityMinutes?: number;
  maxObjects?: number;
  lowLight?: boolean;
  hasSeating?: boolean;
  color?: string;
  sequence?: number;
  artifactIds?: string[];
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

const FALLBACK_ZONE_COLORS = ['#d7654e', '#7c6aa6', '#2f7c75', '#597b8e', '#c7903d', '#a55f72'];

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

export function normalizeZone(zone: LegacyZone, index: number): Zone {
  return {
    id: zone.id,
    name: typeof zone.name === 'string' && zone.name.trim() ? zone.name : `Zone ${index + 1}`,
    shortLabel: typeof zone.shortLabel === 'string' ? zone.shortLabel : '',
    thesis: typeof zone.thesis === 'string' ? zone.thesis : '',
    capacityMinutes: positiveInteger(zone.capacityMinutes, 15),
    maxObjects: positiveInteger(zone.maxObjects, 4),
    lowLight: Boolean(zone.lowLight),
    hasSeating: Boolean(zone.hasSeating),
    color: typeof zone.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(zone.color)
      ? zone.color
      : FALLBACK_ZONE_COLORS[index % FALLBACK_ZONE_COLORS.length],
    sequence: typeof zone.sequence === 'number' && Number.isFinite(zone.sequence) ? zone.sequence : index,
    artifactIds: Array.isArray(zone.artifactIds) ? zone.artifactIds.filter((id): id is string => typeof id === 'string') : [],
  };
}

export function migrateWorkspace(value: unknown): WorkspaceState | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as LegacyWorkspace;
  if (!source.project || !source.artifacts || !source.zones || !source.issues || !source.preferences) return null;
  if (!source.zones.every((zone) => zone && typeof zone.id === 'string')) return null;
  const zones = source.zones.map(normalizeZone).sort((left, right) => left.sequence - right.sequence)
    .map((zone, index) => ({ ...zone, sequence: index }));
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
    issues: state.issues.map((issue) => ({
      ...issue,
      zoneId: issue.zoneId && zoneIds.has(issue.zoneId) ? issue.zoneId : undefined,
      artifactId: issue.artifactId && artifactIds.has(issue.artifactId) ? issue.artifactId : undefined,
    })),
  };
}
