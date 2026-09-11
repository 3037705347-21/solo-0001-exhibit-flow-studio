import { isReleasePackage } from '../domain/release';
import type { ReleasePackage, WorkspaceState } from '../domain/models';

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
  releases?: unknown;
  releaseSequence?: unknown;
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
    releases: sanitizeReleases(source.releases),
    releaseSequence: sanitizeSequence(source.releaseSequence, source.releases),
    lastSavedAt: source.lastSavedAt,
  };
}

function sanitizeReleases(value: unknown): ReleasePackage[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is ReleasePackage => isReleasePackage(entry));
}

function sanitizeSequence(value: unknown, releases: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (Array.isArray(releases)) {
    return releases.reduce((highest, entry) => {
      const number = isReleasePackage(entry) ? entry.number : 0;
      return Math.max(highest, number);
    }, 0);
  }
  return 0;
}

export function validateReferences(state: WorkspaceState): WorkspaceState {
  const artifactIds = new Set(state.artifacts.map((artifact) => artifact.id));
  const zoneIds = new Set(state.zones.map((zone) => zone.id));
  return {
    ...state,
    zones: state.zones.map((zone) => ({ ...zone, artifactIds: zone.artifactIds.filter((id) => artifactIds.has(id)) })),
    issues: state.issues.map((issue) => {
      // JSON persistence turns missing optional links into explicit null; drop those
      // keys so records match the domain shape and release fingerprints stay stable.
      const normalized: typeof issue = { ...issue };
      const zoneId = issue.zoneId && zoneIds.has(issue.zoneId) ? issue.zoneId : undefined;
      const artifactId = issue.artifactId && artifactIds.has(issue.artifactId) ? issue.artifactId : undefined;
      if (zoneId) normalized.zoneId = zoneId;
      else delete normalized.zoneId;
      if (artifactId) normalized.artifactId = artifactId;
      else delete normalized.artifactId;
      if (!normalized.resolvedAt) delete normalized.resolvedAt;
      return normalized;
    }),
  };
}
