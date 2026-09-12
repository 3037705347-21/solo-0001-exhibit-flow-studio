import { isCollectionFilter } from '../domain/collectionViews';
import type { CollectionRuleVersion, CollectionView, FrozenMemberSnapshot, WorkspaceState } from '../domain/models';

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
  collectionViews?: unknown;
  lastSavedAt?: string;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function sanitizeRuleVersion(value: unknown): CollectionRuleVersion | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<CollectionRuleVersion>;
  if (typeof candidate.version !== 'number'
    || !isCollectionFilter(candidate.rules)
    || !isStringArray(candidate.memberIds)
    || typeof candidate.basis !== 'string'
    || typeof candidate.createdAt !== 'string') {
    return null;
  }
  return {
    version: candidate.version,
    rules: candidate.rules,
    memberIds: candidate.memberIds,
    basis: candidate.basis,
    createdAt: candidate.createdAt,
  };
}

/**
 * Recover saved views from older/partial storage. Frozen member references are
 * deliberately left intact even when the referenced object is gone: the drift
 * marker is the evidence that an issued list no longer matches the collection.
 */
export function sanitizeCollectionViews(value: unknown): CollectionView[] {
  if (!Array.isArray(value)) return [];
  const views: CollectionView[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as Partial<CollectionView>;
    if (typeof candidate.id !== 'string'
      || typeof candidate.name !== 'string'
      || (candidate.kind !== 'live' && candidate.kind !== 'frozen')
      || typeof candidate.createdAt !== 'string'
      || typeof candidate.updatedAt !== 'string'
      || !Array.isArray(candidate.ruleVersions)) {
      continue;
    }
    const ruleVersions = candidate.ruleVersions
      .map((version) => sanitizeRuleVersion(version))
      .filter((version): version is CollectionRuleVersion => Boolean(version))
      .sort((left, right) => left.version - right.version);
    if (!ruleVersions.length) continue;
    if (candidate.kind === 'frozen') {
      // The issued member record must exist as an array. An empty array is a
      // legitimate state (the list was issued while nothing matched its rules)
      // and must survive reload; only a missing/non-array record is corrupted.
      if (!Array.isArray(candidate.frozenMembers)) continue;
    }
    const frozenMembers = candidate.kind === 'frozen'
      ? (candidate.frozenMembers as unknown[]).filter((member): member is FrozenMemberSnapshot =>
        Boolean(member)
        && typeof member === 'object'
        && typeof (member as { artifactId?: unknown }).artifactId === 'string'
        && typeof (member as { accessionId?: unknown }).accessionId === 'string'
        && typeof (member as { title?: unknown }).title === 'string'
        && typeof (member as { narrativeRole?: unknown }).narrativeRole === 'string'
        && typeof (member as { sensitivity?: unknown }).sensitivity === 'string'
        && typeof (member as { isKeyObject?: unknown }).isKeyObject === 'boolean')
      : undefined;
    views.push({
      id: candidate.id,
      name: candidate.name,
      kind: candidate.kind,
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
      ruleVersions,
      ...(frozenMembers ? { frozenMembers } : {}),
    });
  }
  return views;
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
    collectionViews: sanitizeCollectionViews(source.collectionViews),
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
    // Frozen list references are intentionally not pruned; deletion is surfaced as drift.
  };
}
