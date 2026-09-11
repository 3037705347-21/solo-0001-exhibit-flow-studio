import { createId } from './ids';
import {
  ACCESSIBILITY_NEEDS,
  ISSUE_SEVERITIES,
  ISSUE_STATUSES,
  NARRATIVE_ROLES,
  PACES,
  PROJECT_STAGES,
  SENSITIVITIES,
  WORKSPACE_SCHEMA_VERSION,
  type AccessibilityNeed,
  type Artifact,
  type ExhibitProject,
  type IssueSeverity,
  type IssueStatus,
  type NarrativeRole,
  type PlanningPreferences,
  type ReviewIssue,
  type Sensitivity,
  type WorkspaceState,
  type Zone,
} from './models';

export type WorkspaceRecordKind = 'project' | 'preferences' | 'artifact' | 'zone' | 'issue';

export interface StructuralIssue {
  code: string;
  message: string;
  path: string;
  recordKind?: WorkspaceRecordKind;
  recordId?: string;
  /** Repairable issues receive a default value; fatal (non-repairable root) issues stop the import. */
  repairable: boolean;
}

export interface StructuralReport {
  issues: StructuralIssue[];
  fatal: StructuralIssue[];
}

export function createStructuralReport(issues: StructuralIssue[] = []): StructuralReport {
  return { issues, fatal: issues.filter((issue) => !issue.repairable && issue.path === '$') };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function timestamp(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

const FALLBACK_TIMESTAMP = '1970-01-01T00:00:00.000Z';

function normalizeProject(raw: unknown, issues: StructuralIssue[]): ExhibitProject | null {
  if (!isRecord(raw)) {
    issues.push({ code: 'project-missing', message: 'The project record is missing or malformed.', path: '$', recordKind: 'project', repairable: false });
    return null;
  }
  let id = asString(raw.id)?.trim();
  if (!id) {
    id = createId('project');
    issues.push({ code: 'project-id', message: 'Project had no id; a new one was assigned.', path: '$.project.id', recordKind: 'project', repairable: true });
  }
  const repairs: Array<[keyof ExhibitProject, string]> = [];
  if (!asString(raw.title)?.trim()) repairs.push(['title', 'Project title defaulted to "Untitled exhibition".']);
  if (!asString(raw.venue)?.trim()) repairs.push(['venue', 'Project venue defaulted to "Venue unknown".']);
  if (!asString(raw.audience)?.trim()) repairs.push(['audience', 'Project audience defaulted.']);
  if (!asString(raw.openingDate)?.trim()) repairs.push(['openingDate', 'Opening date defaulted to empty.']);
  const stage = enumValue(raw.stage, PROJECT_STAGES);
  if (!stage) repairs.push(['stage', 'Project stage defaulted to draft.']);
  for (const [field, message] of repairs) {
    issues.push({ code: `project-${String(field)}`, message, path: `$.project.${String(field)}`, recordKind: 'project', recordId: id, repairable: true });
  }
  return {
    id,
    title: (asString(raw.title)?.trim()) ?? 'Untitled exhibition',
    venue: (asString(raw.venue)?.trim()) ?? 'Venue unknown',
    audience: (asString(raw.audience)?.trim()) ?? 'Audience unspecified',
    openingDate: asString(raw.openingDate)?.trim() ?? '',
    stage: stage ?? 'draft',
    lastReadinessCheck: asString(raw.lastReadinessCheck),
  };
}

function normalizePreferences(raw: unknown, issues: StructuralIssue[]): PlanningPreferences {
  const source = isRecord(raw) ? raw : {};
  if (!isRecord(raw)) {
    issues.push({ code: 'preferences-missing', message: 'Planning preferences were missing; defaults were applied.', path: '$.preferences', recordKind: 'preferences', repairable: true });
  }
  const pace = enumValue(source.pace, PACES);
  if (!pace) issues.push({ code: 'preferences-pace', message: 'Visit pace defaulted to balanced.', path: '$.preferences.pace', recordKind: 'preferences', repairable: true });
  const groupSize = positiveNumber(source.groupSize);
  if (groupSize === undefined) issues.push({ code: 'preferences-group-size', message: 'Group size defaulted to 6.', path: '$.preferences.groupSize', recordKind: 'preferences', repairable: true });
  const priority = typeof source.accessibilityPriority === 'number' && source.accessibilityPriority >= 0 && source.accessibilityPriority <= 100
    ? source.accessibilityPriority
    : undefined;
  if (priority === undefined) issues.push({ code: 'preferences-priority', message: 'Accessibility priority defaulted to 50%.', path: '$.preferences.accessibilityPriority', recordKind: 'preferences', repairable: true });
  const buffer = typeof source.transitionBufferMinutes === 'number' && source.transitionBufferMinutes >= 0 && source.transitionBufferMinutes <= 60
    ? source.transitionBufferMinutes
    : undefined;
  const cues = typeof source.showTransitionCues === 'boolean' ? source.showTransitionCues : undefined;
  return {
    pace: pace ?? 'balanced',
    accessibilityPriority: priority ?? 50,
    groupSize: groupSize ? Math.round(groupSize) : 6,
    ...(buffer === undefined ? {} : { transitionBufferMinutes: buffer }),
    ...(cues === undefined ? {} : { showTransitionCues: cues }),
  };
}

function normalizeArtifact(raw: unknown, index: number, issues: StructuralIssue[]): Artifact | null {
  if (!isRecord(raw)) {
    issues.push({ code: 'artifact-malformed', message: `Object #${index + 1} was not a record and could not be read.`, path: '$.artifacts', recordKind: 'artifact', repairable: false });
    return null;
  }
  let id = asString(raw.id)?.trim();
  if (!id) {
    id = createId('artifact');
    issues.push({ code: 'artifact-id', message: 'Object had no id; a new one was assigned.', path: '$.artifacts[].id', recordKind: 'artifact', repairable: true });
  }
  const dimensions = isRecord(raw.dimensions) ? raw.dimensions : undefined;
  const width = positiveNumber(dimensions?.width);
  const height = positiveNumber(dimensions?.height);
  const depth = positiveNumber(dimensions?.depth);
  const dwell = positiveNumber(raw.dwellMinutes);
  if (width === undefined || height === undefined || depth === undefined || dwell === undefined) {
    issues.push({
      code: 'artifact-invalid-measures',
      message: `Object "${asString(raw.title)?.trim() || `#${index + 1}`}" has invalid dimensions or dwell time and cannot be safely restored.`,
      path: '$.artifacts',
      recordKind: 'artifact',
      recordId: id,
      repairable: false,
    });
    return null;
  }
  const repairs: string[] = [];
  const title = asString(raw.title)?.trim();
  if (!title) repairs.push('title');
  const accessionId = asString(raw.accessionId)?.trim();
  if (!accessionId) repairs.push('accessionId');
  const role = enumValue(raw.narrativeRole, NARRATIVE_ROLES);
  if (!role) repairs.push('narrativeRole');
  const sensitivity = enumValue(raw.sensitivity, SENSITIVITIES);
  if (!sensitivity) repairs.push('sensitivity');
  const accessibilityNeed = enumValue(raw.accessibilityNeed, ACCESSIBILITY_NEEDS);
  if (!accessibilityNeed) repairs.push('accessibilityNeed');
  for (const field of repairs) {
    issues.push({ code: `artifact-${field}`, message: `Missing ${field} on "${title ?? `object #${index + 1}`}" was filled with a default.`, path: `$.artifacts[].${field}`, recordKind: 'artifact', recordId: id, repairable: true });
  }
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : [];
  if (Array.isArray(raw.tags) && raw.tags.length !== tags.length) {
    issues.push({ code: 'artifact-tags', message: 'Non-text tags were removed.', path: '$.artifacts[].tags', recordKind: 'artifact', recordId: id, repairable: true });
  }
  return {
    id,
    accessionId: accessionId || `UNKNOWN-${index + 1}`,
    title: title || 'Untitled object',
    maker: asString(raw.maker)?.trim() ?? '',
    yearLabel: asString(raw.yearLabel)?.trim() ?? 'Date unknown',
    medium: asString(raw.medium)?.trim() ?? '',
    origin: asString(raw.origin)?.trim() ?? 'Origin unknown',
    summary: asString(raw.summary)?.trim() ?? '',
    dimensions: { width, height, depth, unit: 'cm' },
    dwellMinutes: dwell,
    narrativeRole: (role ?? 'context') as NarrativeRole,
    sensitivity: (sensitivity ?? 'standard') as Sensitivity,
    accessibilityNeed: (accessibilityNeed ?? 'none') as AccessibilityNeed,
    isKeyObject: booleanOrDefault(raw.isKeyObject, false),
    tags,
    color: asString(raw.color)?.trim() || '#9aa198',
    createdAt: timestamp(raw.createdAt, FALLBACK_TIMESTAMP),
    updatedAt: timestamp(raw.updatedAt, FALLBACK_TIMESTAMP),
  };
}

function normalizeZone(raw: unknown, index: number, issues: StructuralIssue[]): Zone | null {
  if (!isRecord(raw)) {
    issues.push({ code: 'zone-malformed', message: `Zone #${index + 1} was not a record and could not be read.`, path: '$.zones', recordKind: 'zone', repairable: false });
    return null;
  }
  let id = asString(raw.id)?.trim();
  if (!id) {
    id = createId('zone');
    issues.push({ code: 'zone-id', message: 'Zone had no id; a new one was assigned.', path: '$.zones[].id', recordKind: 'zone', repairable: true });
  }
  const name = asString(raw.name)?.trim();
  if (!name) issues.push({ code: 'zone-name', message: `Zone #${index + 1} name defaulted.`, path: '$.zones[].name', recordKind: 'zone', recordId: id, repairable: true });
  const capacity = positiveNumber(raw.capacityMinutes);
  if (capacity === undefined) issues.push({ code: 'zone-capacity', message: `Zone "${name ?? `#${index + 1}`}" had no valid dwell capacity; 60 minutes was assumed.`, path: '$.zones[].capacityMinutes', recordKind: 'zone', recordId: id, repairable: true });
  const maxObjects = positiveNumber(raw.maxObjects);
  if (maxObjects === undefined) issues.push({ code: 'zone-max-objects', message: `Zone "${name ?? `#${index + 1}`}" object capacity defaulted to 8.`, path: '$.zones[].maxObjects', recordKind: 'zone', recordId: id, repairable: true });
  if (typeof raw.sequence !== 'number') issues.push({ code: 'zone-sequence', message: `Zone "${name ?? `#${index + 1}`}" sequence defaulted to its file position.`, path: '$.zones[].sequence', recordKind: 'zone', recordId: id, repairable: true });
  const rawIds = Array.isArray(raw.artifactIds) ? raw.artifactIds : [];
  const artifactIds = rawIds.filter((ref): ref is string => typeof ref === 'string' && ref.trim().length > 0);
  if (rawIds.length !== artifactIds.length) {
    issues.push({ code: 'zone-placement-ref-type', message: 'Non-text placement references were removed.', path: '$.zones[].artifactIds', recordKind: 'zone', recordId: id, repairable: true });
  }
  return {
    id,
    name: name ?? `Recovered zone ${index + 1}`,
    shortLabel: asString(raw.shortLabel)?.trim() ?? name ?? `Zone ${index + 1}`,
    thesis: asString(raw.thesis)?.trim() ?? '',
    capacityMinutes: capacity ?? 60,
    maxObjects: maxObjects ? Math.round(maxObjects) : 8,
    lowLight: booleanOrDefault(raw.lowLight, false),
    hasSeating: booleanOrDefault(raw.hasSeating, false),
    color: asString(raw.color)?.trim() || '#5f7a72',
    sequence: typeof raw.sequence === 'number' ? raw.sequence : index,
    artifactIds,
  };
}

function normalizeIssue(raw: unknown, index: number, issues: StructuralIssue[]): ReviewIssue | null {
  if (!isRecord(raw)) {
    issues.push({ code: 'issue-malformed', message: `Finding #${index + 1} was not a record and could not be read.`, path: '$.issues', recordKind: 'issue', repairable: false });
    return null;
  }
  let id = asString(raw.id)?.trim();
  if (!id) {
    id = createId('issue');
    issues.push({ code: 'issue-id', message: 'Finding had no id; a new one was assigned.', path: '$.issues[].id', recordKind: 'issue', repairable: true });
  }
  const title = asString(raw.title)?.trim();
  if (!title) issues.push({ code: 'issue-title', message: `Finding #${index + 1} title defaulted.`, path: '$.issues[].title', recordKind: 'issue', recordId: id, repairable: true });
  const severity = enumValue(raw.severity, ISSUE_SEVERITIES);
  if (!severity) issues.push({ code: 'issue-severity', message: `Finding "${title ?? `#${index + 1}`}" severity defaulted to note.`, path: '$.issues[].severity', recordKind: 'issue', recordId: id, repairable: true });
  const status = enumValue(raw.status, ISSUE_STATUSES);
  if (!status) issues.push({ code: 'issue-status', message: `Finding "${title ?? `#${index + 1}`}" status defaulted to open.`, path: '$.issues[].status', recordKind: 'issue', recordId: id, repairable: true });
  return {
    id,
    title: title ?? 'Recovered finding',
    description: asString(raw.description)?.trim() ?? '',
    severity: (severity ?? 'note') as IssueSeverity,
    status: (status ?? 'open') as IssueStatus,
    zoneId: asString(raw.zoneId),
    artifactId: asString(raw.artifactId),
    owner: asString(raw.owner)?.trim() || 'Unassigned',
    createdAt: timestamp(raw.createdAt, FALLBACK_TIMESTAMP),
    updatedAt: timestamp(raw.updatedAt, FALLBACK_TIMESTAMP),
    resolvedAt: asString(raw.resolvedAt),
  };
}

export interface NormalizedWorkspace {
  /** Null when a fatal structural issue is present; nothing about it may be restored. */
  state: WorkspaceState | null;
  issues: StructuralIssue[];
}

/**
 * Single structural validation path for every workspace-shaped object: imported
 * files, automatic migration at startup, and the built-in sample plan all run
 * through here. Repairable records come back with defaults; unrecoverable ones
 * are dropped, with every decision reported.
 */
export function normalizeWorkspaceShape(raw: unknown): NormalizedWorkspace | null {
  if (!isRecord(raw)) return null;
  const issues: StructuralIssue[] = [];
  for (const key of ['artifacts', 'zones', 'issues'] as const) {
    if (!Array.isArray(raw[key])) {
      issues.push({ code: `missing-${key}`, message: `Required collection "${key}" is missing; it was treated as empty.`, path: `$.${key}`, repairable: true });
    }
  }

  const project = normalizeProject(raw.project, issues);
  const preferences = normalizePreferences(raw.preferences, issues);
  const artifacts = Array.isArray(raw.artifacts)
    ? raw.artifacts.map((entry, index) => normalizeArtifact(entry, index, issues)).filter((entry): entry is Artifact => entry !== null)
    : [];
  const zones = Array.isArray(raw.zones)
    ? raw.zones.map((entry, index) => normalizeZone(entry, index, issues)).filter((entry): entry is Zone => entry !== null)
    : [];
  const issuesList = Array.isArray(raw.issues)
    ? raw.issues.map((entry, index) => normalizeIssue(entry, index, issues)).filter((entry): entry is ReviewIssue => entry !== null)
    : [];

  // Accession ids must be unique. Later duplicates cannot be safely kept.
  const seenAccessions = new Set<string>();
  const dedupedArtifacts: Artifact[] = [];
  for (const artifact of artifacts) {
    const key = artifact.accessionId.toUpperCase();
    if (seenAccessions.has(key)) {
      issues.push({ code: 'artifact-duplicate-accession', message: `Duplicate accession id ${artifact.accessionId} ("${artifact.title}") was dropped.`, path: '$.artifacts', recordKind: 'artifact', recordId: artifact.id, repairable: false });
      continue;
    }
    seenAccessions.add(key);
    dedupedArtifacts.push(artifact);
  }

  // Zone ids must be unique as well.
  const seenZoneIds = new Set<string>();
  const dedupedZones: Zone[] = [];
  for (const zone of zones) {
    if (seenZoneIds.has(zone.id)) {
      issues.push({ code: 'zone-duplicate-id', message: `Duplicate zone "${zone.name}" was dropped.`, path: '$.zones', recordKind: 'zone', recordId: zone.id, repairable: false });
      continue;
    }
    seenZoneIds.add(zone.id);
    dedupedZones.push(zone);
  }

  // Finding ids too.
  const seenIssueIds = new Set<string>();
  const dedupedIssues: ReviewIssue[] = [];
  for (const issue of issuesList) {
    if (seenIssueIds.has(issue.id)) {
      issues.push({ code: 'issue-duplicate-id', message: `Duplicate finding "${issue.title}" was dropped.`, path: '$.issues', recordKind: 'issue', recordId: issue.id, repairable: false });
      continue;
    }
    seenIssueIds.add(issue.id);
    dedupedIssues.push(issue);
  }

  if (!project) return { state: null, issues };

  return {
    issues,
    state: {
      version: WORKSPACE_SCHEMA_VERSION,
      project,
      artifacts: dedupedArtifacts,
      zones: dedupedZones,
      issues: dedupedIssues,
      preferences,
    },
  };
}

/**
 * Validates an already-migrated {@link WorkspaceState} (the sample plan and
 * every export run through this). A report with fatal issues must never be
 * written or exported.
 */
export function validateWorkspaceState(state: WorkspaceState): StructuralReport {
  if (!isRecord(state) || state.version !== WORKSPACE_SCHEMA_VERSION) {
    return createStructuralReport([{ code: 'version', message: `Workspace must be at version ${WORKSPACE_SCHEMA_VERSION}.`, path: '$', repairable: false }]);
  }
  const normalized = normalizeWorkspaceShape(state);
  if (!normalized) {
    return createStructuralReport([{ code: 'shape', message: 'Workspace is not an object.', path: '$', repairable: false }]);
  }
  return createStructuralReport(normalized.issues);
}

/** Defensive reference cleanup used on the automatic startup path. */
export function repairBrokenReferences(state: WorkspaceState): WorkspaceState {
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

export const ENUM_LABELS = {
  narrativeRole: NARRATIVE_ROLES,
  sensitivity: SENSITIVITIES,
  accessibilityNeed: ACCESSIBILITY_NEEDS,
  severity: ISSUE_SEVERITIES,
  status: ISSUE_STATUSES,
  stage: PROJECT_STAGES,
  pace: PACES,
} as const;
