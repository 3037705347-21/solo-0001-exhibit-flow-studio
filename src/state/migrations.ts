import type { RotationBatch, RotationPlan, WorkspaceState } from '../domain/models';

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
  rotationPlans?: unknown;
  lastSavedAt?: string;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function sanitizeDependency(value: unknown): RotationBatch['dependencies'][number] | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.artifactId !== 'string' || typeof candidate.artifactTitle !== 'string') return null;
  if (typeof candidate.sensitivity !== 'string' || typeof candidate.artifactVersion !== 'string') return null;
  return {
    artifactId: candidate.artifactId,
    artifactTitle: candidate.artifactTitle,
    sensitivity: candidate.sensitivity as RotationBatch['dependencies'][number]['sensitivity'],
    artifactVersion: candidate.artifactVersion,
    zoneId: typeof candidate.zoneId === 'string' ? candidate.zoneId : undefined,
    zoneName: typeof candidate.zoneName === 'string' ? candidate.zoneName : undefined,
    zoneVersion: typeof candidate.zoneVersion === 'string' ? candidate.zoneVersion : undefined,
  };
}

function sanitizeStint(value: unknown): RotationBatch['stints'][number] | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== 'display' && candidate.kind !== 'rest') return null;
  if (typeof candidate.startDate !== 'string' || typeof candidate.endDate !== 'string') return null;
  return {
    kind: candidate.kind,
    startDate: candidate.startDate,
    endDate: candidate.endDate,
    zoneId: typeof candidate.zoneId === 'string' ? candidate.zoneId : undefined,
    zoneName: typeof candidate.zoneName === 'string' ? candidate.zoneName : undefined,
    loadMinutes: typeof candidate.loadMinutes === 'number' ? candidate.loadMinutes : 0,
  };
}

function sanitizeBatch(value: unknown): RotationBatch | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || typeof candidate.label !== 'string') return null;
  if (candidate.rotationClass !== 'low-light' && candidate.rotationClass !== 'fragile') return null;
  if (!isStringArray(candidate.artifactIds)) return null;
  const dependencies = Array.isArray(candidate.dependencies)
    ? candidate.dependencies.map(sanitizeDependency).filter((entry): entry is RotationBatch['dependencies'][number] => entry !== null)
    : [];
  const stints = Array.isArray(candidate.stints)
    ? candidate.stints.map(sanitizeStint).filter((entry): entry is RotationBatch['stints'][number] => entry !== null)
    : [];
  return {
    id: candidate.id,
    label: candidate.label,
    rotationClass: candidate.rotationClass,
    displayDays: typeof candidate.displayDays === 'number' ? candidate.displayDays : 0,
    restDays: typeof candidate.restDays === 'number' ? candidate.restDays : 0,
    artifactIds: candidate.artifactIds,
    stints,
    dependencies,
    manual: Boolean(candidate.manual),
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : new Date(0).toISOString(),
  };
}

export function sanitizeRotationPlans(value: unknown): RotationPlan[] {
  if (!Array.isArray(value)) return [];
  const plans: RotationPlan[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string') continue;
    if (typeof candidate.openingDate !== 'string') continue;
    const status = candidate.status === 'confirmed' || candidate.status === 'review' ? candidate.status : 'draft';
    const batches = Array.isArray(candidate.batches)
      ? candidate.batches.map(sanitizeBatch).filter((batch): batch is RotationBatch => batch !== null)
      : [];
    plans.push({
      id: candidate.id,
      name: candidate.name,
      status,
      openingDate: candidate.openingDate,
      horizonDays: typeof candidate.horizonDays === 'number' ? candidate.horizonDays : 240,
      batchIds: isStringArray(candidate.batchIds) ? candidate.batchIds : batches.map((batch) => batch.id),
      batches,
      warnings: Array.isArray(candidate.warnings) ? candidate.warnings.filter((warning): warning is string => typeof warning === 'string') : [],
      reviewReasons: Array.isArray(candidate.reviewReasons) ? candidate.reviewReasons.filter((reason): reason is string => typeof reason === 'string') : [],
      createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date(0).toISOString(),
      updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : new Date(0).toISOString(),
      confirmedAt: typeof candidate.confirmedAt === 'string' ? candidate.confirmedAt : undefined,
    });
  }
  return plans;
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
    rotationPlans: sanitizeRotationPlans(source.rotationPlans),
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
