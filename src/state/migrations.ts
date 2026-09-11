import type {
  AccessibilityNeed,
  Artifact,
  IssueSeverity,
  IssueStatus,
  NarrativeRole,
  PlanningPreferences,
  ProjectStage,
  ReviewIssue,
  Sensitivity,
  WorkspaceState,
  WorkspaceVersion,
  Zone,
} from '../domain/models';
import { CURRENT_WORKSPACE_VERSION } from '../domain/models';
import { createId, normalizeAccessionId } from '../domain/ids';

/* ------------------------------------------------------------------ */
/* Public report types                                                 */
/* ------------------------------------------------------------------ */

export type MigrationVerdict = 'added' | 'kept' | 'invalid' | 'review';
export type MigrationRecordType = 'project' | 'preferences' | 'artifact' | 'zone' | 'issue' | 'reference';
export type RecordDecision = 'keep' | 'drop';
export type ReviewDecisions = Record<string, RecordDecision>;

export interface MigrationEntry {
  /** Unique within a report; used as the key for reviewer decisions. */
  id: string;
  recordType: MigrationRecordType;
  /** Identity of the record this entry describes (source ID). */
  recordId: string;
  label: string;
  verdict: MigrationVerdict;
  detail: string;
  decision: RecordDecision;
  adjustable: boolean;
}

export interface MigrationStep {
  from: number;
  to: number;
  description: string;
}

export type SourceFormat = 'workspace-file' | 'legacy-state' | 'versionless-state';

export interface MigrationReport {
  sourceVersion: WorkspaceVersion;
  sourceFormat: SourceFormat;
  steps: MigrationStep[];
  entries: MigrationEntry[];
}

export interface MigrationCounters {
  added: number;
  kept: number;
  invalid: number;
  review: number;
}

export interface MigrationPlan {
  report: MigrationReport;
  /** Proposed v2 state with default decisions applied (reviewable records kept). */
  state: WorkspaceState;
  counters: MigrationCounters;
  /** Source record ID -> current state ID when collision repair renamed a record. */
  idAliases: Record<string, string>;
}

export type PlanResult =
  | { ok: true; plan: MigrationPlan }
  | { ok: false; reason: string };

export interface AppliedMigration {
  state: WorkspaceState;
  report: MigrationReport;
  counters: MigrationCounters;
  /** Review entries the reviewer explicitly decided (either keep or drop). */
  confirmedCount: number;
}

/* ------------------------------------------------------------------ */
/* Version detection                                                   */
/* ------------------------------------------------------------------ */

export const WORKSPACE_FILE_KIND = 'exhibit-flow.workspace-file';

/**
 * Identify the original version of an imported document. Accepts the current
 * workspace-file envelope as well as bare state dumps from older builds.
 * Readiness snapshots are explicitly rejected: they are reports, not
 * restorable workspaces.
 */
export function detectWorkspaceVersion(raw: unknown): DetectionResult {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'The file is not valid JSON.' };
    }
  }
  const envelope = asRecord(raw);
  if (!envelope) return { ok: false, reason: 'The file does not contain a workspace object.' };

  if (envelope.kind === WORKSPACE_FILE_KIND) {
    const inner = asRecord(envelope.workspace);
    if (!inner) return { ok: false, reason: 'The workspace file is missing its "workspace" section.' };
    const version = readVersion(inner);
    if (version !== CURRENT_WORKSPACE_VERSION) {
      return { ok: false, reason: `Workspace files exported by version ${version} are not supported by this build.` };
    }
    return { ok: true, version, format: 'workspace-file', workspace: inner };
  }

  if (envelope.kind !== undefined) return { ok: false, reason: `Unknown file kind "${String(envelope.kind)}".` };
  if (envelope.schemaVersion !== undefined) {
    return {
      ok: false,
      reason: 'This is a readiness snapshot, not a workspace file. Snapshots are exported reports and cannot be restored as an editable plan.',
    };
  }

  const declaredVersion = envelope.version;
  if (declaredVersion === 2) return { ok: true, version: 2, format: 'legacy-state', workspace: envelope };
  if (declaredVersion === 1) return { ok: true, version: 1, format: 'legacy-state', workspace: envelope };
  if (declaredVersion !== undefined) {
    return { ok: false, reason: `Workspace version ${String(declaredVersion)} is not supported.` };
  }

  // Bare state without a version tag: distinguish the pre-sequence (v0)
  // export from a versionless dump that is already structurally v1.
  const zones = Array.isArray(envelope.zones) ? envelope.zones as unknown[] : [];
  const hasDwellSeconds = Array.isArray(envelope.artifacts)
    && (envelope.artifacts as unknown[]).some((entry) => asRecord(entry)?.dwellSeconds !== undefined);
  const missingSequence = zones.some((zone) => asRecord(zone)?.sequence === undefined);
  if (hasDwellSeconds || (zones.length > 0 && missingSequence)) {
    return { ok: true, version: 0, format: 'versionless-state', workspace: envelope };
  }
  return { ok: true, version: 1, format: 'versionless-state', workspace: envelope };
}

export type DetectionResult =
  | { ok: true; version: WorkspaceVersion; format: SourceFormat; workspace: unknown }
  | { ok: false; reason: string };

function readVersion(record: Record<string, unknown>): WorkspaceVersion {
  const version = record.version;
  return version === 2 || version === 1 ? version : 0;
}

/* ------------------------------------------------------------------ */
/* Small migration helpers                                             */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Guarantees unique entry ids: the first entry per record is canonical. */
class EntryCollector {
  private counts = new Map<string, number>();
  readonly entries: MigrationEntry[] = [];

  add(
    recordType: MigrationRecordType,
    recordId: string,
    label: string,
    verdict: MigrationVerdict,
    detail: string,
    options: { decision?: RecordDecision; adjustable?: boolean; key?: string } = {},
  ): MigrationEntry {
    const base = `${recordType}:${recordId}${options.key ? `:${options.key}` : ''}`;
    const seen = (this.counts.get(base) ?? 0) + 1;
    this.counts.set(base, seen);
    const created: MigrationEntry = {
      id: seen === 1 ? base : `${base}#${seen}`,
      recordType,
      recordId,
      label,
      verdict,
      detail,
      decision: options.decision ?? 'keep',
      adjustable: options.adjustable ?? false,
    };
    this.entries.push(created);
    return created;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

function timestamp(value: unknown, fallback: string): string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : fallback;
}

const ROLES = ['threshold', 'context', 'turning-point', 'reflection'] as const;
const SENSITIVITIES = ['standard', 'low-light', 'fragile'] as const;
const ACCESS_NEEDS = ['none', 'seating', 'audio', 'tactile-alternative'] as const;
const SEVERITIES = ['note', 'warning', 'critical'] as const;
const STATUSES = ['open', 'in-progress', 'resolved'] as const;
const STAGES = ['draft', 'review', 'ready'] as const;
const PACES = ['focused', 'balanced', 'leisurely'] as const;

const DEFAULT_COLOR = '#c9563f';

/* ------------------------------------------------------------------ */
/* v0/v1 field-level migration                                         */
/* ------------------------------------------------------------------ */

interface V1Draft {
  project: WorkspaceState['project'];
  preferences: PlanningPreferences;
  artifacts: Artifact[];
  zones: Zone[];
  issues: ReviewIssue[];
}

function migrateProjectV0(source: Record<string, unknown>, collector: EntryCollector): WorkspaceState['project'] {
  const projectSource = asRecord(source.project);
  if (!projectSource) {
    const project = {
      id: createId('project'),
      title: 'Restored exhibition',
      venue: 'Venue unknown',
      audience: 'General visitors',
      openingDate: '',
      stage: 'review' as const,
    };
    collector.add('project', project.id, project.title, 'added', 'No project section existed; default exhibition details were created.');
    return project;
  }

  const stage = enumValue(projectSource.stage, STAGES, 'review');
  const project = {
    id: text(projectSource.id) ?? createId('project'),
    title: text(projectSource.title) ?? 'Restored exhibition',
    venue: text(projectSource.venue) ?? 'Venue unknown',
    audience: text(projectSource.audience) ?? 'General visitors',
    openingDate: text(projectSource.openingDate) ?? '',
    stage,
    ...(text(projectSource.lastReadinessCheck) ? { lastReadinessCheck: text(projectSource.lastReadinessCheck)! } : {}),
  };
  const reviews: string[] = [];
  const adds: string[] = [];
  if (projectSource.stage !== stage) adds.push(`Unrecognized project stage was reset to "review".`);
  if (!text(projectSource.id)) adds.push('A project identifier was assigned.');
  if (!text(projectSource.title)) reviews.push('Project title is missing; "Restored exhibition" is used until edited.');
  if (!text(projectSource.venue)) adds.push('Venue was missing and set to "Venue unknown".');
  if (!text(projectSource.audience)) adds.push('Audience was missing and set to "General visitors".');
  if (!text(projectSource.openingDate)) adds.push('Opening date was missing.');

  if (reviews.some((detail) => detail.includes('title'))) {
    collector.add('project', project.id, project.title, 'review', reviews.join(' '), { adjustable: true });
  } else {
    collector.add('project', project.id, project.title, 'kept', 'Project details carried over.');
  }
  adds.forEach((detail, index) => collector.add('project', project.id, project.title, 'added', detail, { key: `p${index}` }));
  return project;
}

function migratePreferencesV0(source: Record<string, unknown>, collector: EntryCollector): PlanningPreferences {
  const preferenceSource = asRecord(source.preferences);
  const preferences: PlanningPreferences = {
    pace: enumValue(preferenceSource?.pace, PACES, 'balanced'),
    accessibilityPriority: isFiniteNumber(preferenceSource?.accessibilityPriority)
      ? Math.max(0, Math.min(100, Math.round(preferenceSource.accessibilityPriority)))
      : 70,
    groupSize: isFiniteNumber(preferenceSource?.groupSize)
      ? Math.max(1, Math.min(30, Math.round(preferenceSource.groupSize)))
      : 6,
    targetVisitMinutes: isFiniteNumber(preferenceSource?.targetVisitMinutes) && preferenceSource.targetVisitMinutes > 0
      ? Math.round(preferenceSource.targetVisitMinutes)
      : null,
  };
  if (preferenceSource) {
    collector.add('preferences', 'planning', 'Planning preferences', 'kept', 'Visitor pace and group preferences carried over.');
  } else {
    collector.add('preferences', 'planning', 'Planning preferences', 'added', 'No preferences section existed; balanced defaults were created.');
  }
  return preferences;
}

interface ArtifactMigration { artifact: Artifact | null }

function migrateArtifactV0(
  record: Record<string, unknown>,
  index: number,
  now: string,
  collector: EntryCollector,
): ArtifactMigration {
  const id = text(record.id) ?? createId('artifact');
  const title = text(record.title);
  const label = title ?? text(record.accessionId) ?? `Object row ${index + 1}`;
  const reviews: string[] = [];
  const adds: string[] = [];

  if (!text(record.id)) reviews.push('The object had no ID; a new identifier is assigned.');
  if (!title) reviews.push('Title is missing; "Untitled object" is used until edited.');

  // dwellSeconds is the v0 field; dwellMinutes the v1+ field.
  let dwellMinutes = 3;
  let fatal: string | null = null;
  if (isFiniteNumber(record.dwellSeconds)) {
    const seconds = record.dwellSeconds;
    if (seconds <= 0) {
      fatal = `Dwell time of ${seconds} seconds is not a positive number.`;
    } else if (seconds % 60 === 0) {
      dwellMinutes = seconds / 60;
      adds.push(`Dwell time converted from ${seconds} seconds to ${dwellMinutes} minutes.`);
    } else {
      dwellMinutes = Math.max(1, Math.round(seconds / 60));
      reviews.push(`${seconds} seconds does not divide evenly into minutes; keeping the record rounds it to ${dwellMinutes} minutes.`);
    }
  } else if (isFiniteNumber(record.dwellMinutes)) {
    dwellMinutes = record.dwellMinutes;
    if (dwellMinutes <= 0) fatal = `Dwell time (${dwellMinutes} minutes) is not positive.`;
    else if (dwellMinutes > 30) reviews.push(`Dwell time of ${dwellMinutes} minutes is above the 30-minute editor limit; the recorded value is kept as-is.`);
  } else {
    dwellMinutes = 3;
    reviews.push('Dwell time is missing; 3 minutes is assumed until confirmed.');
  }

  const dimensionsSource = asRecord(record.dimensions);
  let dimensions: Artifact['dimensions'];
  if (dimensionsSource
    && isFiniteNumber(dimensionsSource.width) && dimensionsSource.width > 0
    && isFiniteNumber(dimensionsSource.height) && dimensionsSource.height > 0
    && isFiniteNumber(dimensionsSource.depth) && dimensionsSource.depth > 0) {
    dimensions = { width: dimensionsSource.width, height: dimensionsSource.height, depth: dimensionsSource.depth, unit: 'cm' };
  } else {
    dimensions = { width: 10, height: 10, depth: 10, unit: 'cm' };
    reviews.push('Dimensions are missing or invalid; a 10 × 10 × 10 cm placeholder is used.');
  }

  if (!text(record.accessionId)) adds.push('Accession ID was missing; a temporary UNKNOWN identifier is assigned.');
  for (const field of ['maker', 'medium', 'summary'] as const) {
    if (!text(record[field])) adds.push(`Missing "${field}" text was filled with a placeholder.`);
  }
  if (!text(record.color)) adds.push('A default display color was assigned.');
  if (!Array.isArray(record.tags)) adds.push('No tag list was present; tags were initialized empty.');
  if (typeof record.isKeyObject !== 'boolean') adds.push('Key-object flag was missing and defaulted to false.');
  if (!text(record.createdAt)) adds.push('Creation timestamp was missing and defaulted.');

  if (fatal) collector.add('artifact', id, label, 'invalid', fatal, { decision: 'drop' });
  else if (reviews.length) collector.add('artifact', id, label, 'review', reviews.join(' '), { adjustable: true });
  else collector.add('artifact', id, label, 'kept', 'Object record carried over.');
  adds.forEach((detail, addIndex) => collector.add('artifact', id, label, 'added', detail, { key: `a${addIndex}` }));

  if (fatal) return { artifact: null };

  const createdAt = timestamp(record.createdAt, now);
  const artifact: Artifact = {
    id,
    accessionId: text(record.accessionId) ?? `UNKNOWN-${id.slice(-6).toUpperCase()}`,
    title: title ?? 'Untitled object',
    maker: text(record.maker) ?? 'Unknown maker',
    yearLabel: text(record.yearLabel) ?? 'Date unknown',
    medium: text(record.medium) ?? 'Medium unrecorded',
    origin: text(record.origin) ?? 'Origin unknown',
    summary: text(record.summary) ?? 'Recovered record awaiting a descriptive summary.',
    dimensions,
    dwellMinutes,
    narrativeRole: enumValue(record.narrativeRole, ROLES, 'context'),
    sensitivity: enumValue(record.sensitivity, SENSITIVITIES, 'standard'),
    accessibilityNeed: enumValue(record.accessibilityNeed, ACCESS_NEEDS, 'none'),
    isKeyObject: typeof record.isKeyObject === 'boolean' ? record.isKeyObject : false,
    tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 8) : [],
    color: text(record.color) ?? DEFAULT_COLOR,
    createdAt,
    updatedAt: timestamp(record.updatedAt, createdAt),
  };
  return { artifact };
}

function migrateZoneV0(record: Record<string, unknown>, index: number, collector: EntryCollector): Zone {
  const id = text(record.id)!;
  const name = text(record.name);
  const label = name ?? `Zone row ${index + 1}`;
  const reviews: string[] = [];
  const adds: string[] = [];

  if (!name) reviews.push('Zone name is missing; "Unnamed zone" is used until edited.');
  const sequence = isFiniteNumber(record.sequence) ? record.sequence : index;
  if (!isFiniteNumber(record.sequence)) adds.push(`Sequence position ${sequence + 1} was assigned from the zone's order in the file.`);
  if (!text(record.shortLabel)) adds.push('Short label was missing and derived from the zone name.');
  if (!isFiniteNumber(record.capacityMinutes) || record.capacityMinutes <= 0) adds.push('Dwell capacity was missing or invalid; a 15-minute target was assigned.');
  if (!isFiniteNumber(record.maxObjects) || record.maxObjects <= 0) adds.push('Object limit was missing or invalid; a limit of 4 was assigned.');
  if (typeof record.lowLight !== 'boolean') adds.push('Low-light flag was missing and defaulted to false.');
  if (typeof record.hasSeating !== 'boolean') adds.push('Seating flag was missing and defaulted to false.');
  if (!Array.isArray(record.artifactIds)) adds.push('Placement list was missing and initialized empty.');

  if (reviews.length) collector.add('zone', id, label, 'review', reviews.join(' '), { adjustable: true });
  else collector.add('zone', id, label, 'kept', 'Zone record carried over.');
  adds.forEach((detail, addIndex) => collector.add('zone', id, label, 'added', detail, { key: `z${addIndex}` }));

  return {
    id,
    name: name ?? 'Unnamed zone',
    shortLabel: text(record.shortLabel) ?? (name ?? 'Unnamed'),
    thesis: text(record.thesis) ?? '',
    capacityMinutes: isFiniteNumber(record.capacityMinutes) && record.capacityMinutes > 0 ? record.capacityMinutes : 15,
    maxObjects: isFiniteNumber(record.maxObjects) && record.maxObjects > 0 ? Math.round(record.maxObjects) : 4,
    lowLight: typeof record.lowLight === 'boolean' ? record.lowLight : false,
    hasSeating: typeof record.hasSeating === 'boolean' ? record.hasSeating : false,
    color: text(record.color) ?? DEFAULT_COLOR,
    sequence,
    artifactIds: Array.isArray(record.artifactIds) ? record.artifactIds.filter((ref): ref is string => typeof ref === 'string') : [],
  };
}

function migrateIssueV0(record: Record<string, unknown>, now: string, collector: EntryCollector): ReviewIssue | null {
  const id = text(record.id)!;
  const title = text(record.title);
  const label = title ?? 'Finding without title';

  if (!title) {
    collector.add('issue', id, label, 'invalid', 'The finding has no title, so it cannot be reviewed or actioned.', { decision: 'drop' });
    return null;
  }

  const severity = enumValue(record.severity, SEVERITIES, 'note');
  const status = enumValue(record.status, STATUSES, 'open');
  const adds: string[] = [];
  if (record.severity !== severity) adds.push('Severity was missing or invalid and reset to "note".');
  if (record.status !== status) adds.push('Status was missing or invalid and reset to "open".');
  if (!text(record.owner)) adds.push('Owner was missing and set to "Unassigned".');
  if (!text(record.createdAt)) adds.push('Created timestamp was missing and defaulted.');

  collector.add('issue', id, label, 'kept', 'Review finding carried over.');
  adds.forEach((detail, addIndex) => collector.add('issue', id, label, 'added', detail, { key: `i${addIndex}` }));

  const createdAt = timestamp(record.createdAt, now);
  const resolvedAt = text(record.resolvedAt) ?? undefined;
  return {
    id,
    title,
    description: typeof record.description === 'string' ? record.description : '',
    severity,
    status,
    ...(text(record.zoneId) ? { zoneId: text(record.zoneId)! } : {}),
    ...(text(record.artifactId) ? { artifactId: text(record.artifactId)! } : {}),
    owner: text(record.owner) ?? 'Unassigned',
    createdAt,
    updatedAt: timestamp(record.updatedAt, createdAt),
    ...(status === 'resolved' || resolvedAt ? { resolvedAt: resolvedAt ?? createdAt } : {}),
  };
}

function migrateV0ToV1(source: Record<string, unknown>, now: string, collector: EntryCollector): V1Draft {
  const project = migrateProjectV0(source, collector);
  const preferences = migratePreferencesV0(source, collector);

  const artifacts: Artifact[] = [];
  const rawArtifacts = Array.isArray(source.artifacts) ? source.artifacts as unknown[] : [];
  if (!Array.isArray(source.artifacts)) {
    collector.add('artifact', 'missing-section', 'Object collection', 'added', 'The file had no objects section; an empty collection was created.');
  }
  rawArtifacts.forEach((rawArtifact, index) => {
    const record = asRecord(rawArtifact);
    if (!record || (!text(record?.id) && !text(record?.title))) {
      collector.add('artifact', `row-${index}`, `Object row ${index + 1}`, 'invalid', 'The record had neither an ID nor a title and could not be identified.', { decision: 'drop' });
      return;
    }
    const result = migrateArtifactV0(record, index, now, collector);
    if (result.artifact) artifacts.push(result.artifact);
  });

  const zones: Zone[] = [];
  const rawZones = Array.isArray(source.zones) ? source.zones as unknown[] : [];
  if (!Array.isArray(source.zones)) {
    collector.add('zone', 'missing-section', 'Visitor journey', 'added', 'The file had no zones section; an empty journey was created.');
  }
  rawZones.forEach((rawZone, index) => {
    const record = asRecord(rawZone);
    if (!record || !text(record?.id)) {
      collector.add('zone', `row-${index}`, `Zone row ${index + 1}`, 'invalid', 'The zone record had no ID and could not be placed in the journey.', { decision: 'drop' });
      return;
    }
    zones.push(migrateZoneV0(record, index, collector));
  });

  const issues: ReviewIssue[] = [];
  const rawIssues = Array.isArray(source.issues) ? source.issues as unknown[] : [];
  if (!Array.isArray(source.issues)) {
    collector.add('issue', 'missing-section', 'Review findings', 'added', 'The file had no findings section; an empty review desk was created.');
  }
  rawIssues.forEach((rawIssue, index) => {
    const record = asRecord(rawIssue);
    if (!record || !text(record?.id)) {
      collector.add('issue', `row-${index}`, `Finding row ${index + 1}`, 'invalid', 'The finding record had no ID and could not be tracked.', { decision: 'drop' });
      return;
    }
    const migrated = migrateIssueV0(record, now, collector);
    if (migrated) issues.push(migrated);
  });

  return { project, preferences, artifacts, zones, issues };
}

/* ------------------------------------------------------------------ */
/* v1 -> v2 migration                                                  */
/* ------------------------------------------------------------------ */

function derivePlanCode(project: WorkspaceState['project']): string {
  const seed = `${project.id}-${project.openingDate}`;
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash << 5) - hash + seed.charCodeAt(index)) | 0;
  }
  const token = Math.abs(hash).toString(36).slice(0, 4).toUpperCase().padStart(4, '0');
  const year = project.openingDate && /^\d{4}/.test(project.openingDate) ? project.openingDate.slice(0, 4) : '0000';
  return `PLN-${year}-${token}`;
}

function migrateV1ToV2(draft: V1Draft, collector: EntryCollector): WorkspaceState {
  const project = { ...draft.project };
  if (!text(project.planCode)) {
    project.planCode = derivePlanCode(project);
    collector.add('project', project.id, project.title, 'added', `Plan code ${project.planCode} was generated for version 2 tracking.`, { key: 'plan-code' });
  }
  collector.add('preferences', 'target-visit', 'Target visit length', 'added', 'Version 2 supports an optional target visit length; left unset until the team defines one.');

  return {
    version: CURRENT_WORKSPACE_VERSION,
    project,
    artifacts: draft.artifacts,
    zones: draft.zones,
    issues: draft.issues,
    preferences: { ...draft.preferences, targetVisitMinutes: null },
  };
}

/* ------------------------------------------------------------------ */
/* Collision repair and reference integrity                            */
/* ------------------------------------------------------------------ */

function repairCollisions(state: WorkspaceState, collector: EntryCollector): { state: WorkspaceState; aliases: Record<string, string> } {
  const aliases: Record<string, string> = {};

  const usedArtifactIds = new Set<string>();
  const usedAccessions = new Map<string, number>();
  const artifacts = state.artifacts.map((sourceArtifact) => {
    let next = sourceArtifact;
    if (usedArtifactIds.has(next.id)) {
      const newId = createId('artifact');
      aliases[next.id] = newId;
      collector.add('artifact', newId, next.title, 'review', `Another object already uses ID "${next.id}"; keeping this copy reassigns it to ${newId}.`, { adjustable: true, key: 'id-collision' });
      next = { ...next, id: newId };
    }
    usedArtifactIds.add(next.id);

    const normalized = normalizeAccessionId(next.accessionId);
    const seenCount = usedAccessions.get(normalized) ?? 0;
    if (seenCount > 0) {
      const replacement = `${normalized}-${seenCount + 1}`;
      collector.add('artifact', next.id, next.title, 'review', `Accession ID ${normalized} is duplicated; keeping this copy renames it to ${replacement}.`, { adjustable: true, key: 'accession-collision' });
      next = { ...next, accessionId: replacement };
    }
    usedAccessions.set(normalized, seenCount + 1);
    return next;
  });

  const usedZoneIds = new Set<string>();
  const zones = state.zones.map((sourceZone) => {
    if (!usedZoneIds.has(sourceZone.id)) {
      usedZoneIds.add(sourceZone.id);
      return sourceZone;
    }
    const newId = createId('zone');
    aliases[sourceZone.id] = newId;
    collector.add('zone', newId, sourceZone.name, 'review', `Another zone already uses ID "${sourceZone.id}"; keeping this copy assigns ${newId}.`, { adjustable: true, key: 'id-collision' });
    usedZoneIds.add(newId);
    return { ...sourceZone, id: newId };
  });

  const usedIssueIds = new Set<string>();
  const issues = state.issues.map((sourceIssue) => {
    if (!usedIssueIds.has(sourceIssue.id)) {
      usedIssueIds.add(sourceIssue.id);
      return sourceIssue;
    }
    const newId = createId('issue');
    aliases[sourceIssue.id] = newId;
    collector.add('issue', newId, sourceIssue.title, 'review', `Another finding already uses ID "${sourceIssue.id}"; keeping this copy assigns ${newId}.`, { adjustable: true, key: 'id-collision' });
    usedIssueIds.add(newId);
    return { ...sourceIssue, id: newId };
  });

  return { state: { ...state, artifacts, zones, issues }, aliases };
}

function scanReferences(state: WorkspaceState, collector: EntryCollector | null): WorkspaceState {
  const artifactIds = new Set(state.artifacts.map((artifact) => artifact.id));
  const zoneIds = new Set(state.zones.map((zone) => zone.id));

  const zones = state.zones.map((zone) => {
    const seen = new Set<string>();
    const next: string[] = [];
    for (const ref of zone.artifactIds) {
      if (!artifactIds.has(ref)) {
        collector?.add('reference', `${zone.id}:placement:${ref}`, `Placement in ${zone.name}`, 'invalid', `References object "${ref}", which is not present in the file. The placement was removed; the object record was not invented.`, { decision: 'drop', key: `${zone.id}-${ref}` });
        continue;
      }
      if (seen.has(ref)) {
        collector?.add('reference', `${zone.id}:duplicate:${ref}`, `Placement in ${zone.name}`, 'invalid', `Object "${ref}" was listed more than once in the zone; the duplicate placement was removed.`, { decision: 'drop', key: `${zone.id}-dup-${ref}` });
        continue;
      }
      seen.add(ref);
      next.push(ref);
    }
    return { ...zone, artifactIds: next };
  });

  const issues = state.issues.map((issue) => {
    let { zoneId, artifactId } = issue;
    if (zoneId !== undefined && !zoneIds.has(zoneId)) {
      collector?.add('reference', `${issue.id}:zone`, `Finding "${issue.title}"`, 'invalid', `Linked zone "${zoneId}" is missing from the file; the zone link was cleared.`, { decision: 'drop', key: `${issue.id}-zone` });
      zoneId = undefined;
    }
    if (artifactId !== undefined && !artifactIds.has(artifactId)) {
      collector?.add('reference', `${issue.id}:artifact`, `Finding "${issue.title}"`, 'invalid', `Linked object "${artifactId}" is missing from the file; the object link was cleared.`, { decision: 'drop', key: `${issue.id}-artifact` });
      artifactId = undefined;
    }
    return { ...issue, zoneId, artifactId };
  });

  return { ...state, zones, issues };
}

/* ------------------------------------------------------------------ */
/* Plan construction and review decisions                              */
/* ------------------------------------------------------------------ */

function countEntries(entries: MigrationEntry[]): MigrationCounters {
  return {
    added: entries.filter((candidate) => candidate.verdict === 'added').length,
    kept: entries.filter((candidate) => candidate.verdict === 'kept').length,
    invalid: entries.filter((candidate) => candidate.verdict === 'invalid').length,
    review: entries.filter((candidate) => candidate.verdict === 'review').length,
  };
}

/**
 * Parse imported text/JSON and produce an ordered, reviewable migration plan.
 * Applying the plan with default decisions always yields a structurally valid
 * v2 state; reviewers can flip any "review" record before committing.
 */
export function buildMigrationPlan(rawInput: unknown, at: Date = new Date()): PlanResult {
  const detection = detectWorkspaceVersion(rawInput);
  if (!detection.ok) return detection;

  const collector = new EntryCollector();
  const now = at.toISOString();
  const source = detection.workspace as Record<string, unknown>;
  const steps: MigrationStep[] = [];
  let state: WorkspaceState;

  if (detection.version === 0) {
    steps.push({ from: 0, to: 1, description: 'Assign zone sequence positions and convert dwell seconds to minutes.' });
    const draft = migrateV0ToV1(source, now, collector);
    steps.push({ from: 1, to: 2, description: 'Add plan codes and the target visit length preference.' });
    state = migrateV1ToV2(draft, collector);
  } else if (detection.version === 1) {
    steps.push({ from: 1, to: 2, description: 'Add plan codes and the target visit length preference.' });
    const draft = migrateV0ToV1(source, now, collector);
    state = migrateV1ToV2(draft, collector);
  } else {
    const parsed = source as unknown as WorkspaceState;
    state = {
      version: CURRENT_WORKSPACE_VERSION,
      project: { ...parsed.project },
      artifacts: parsed.artifacts.map((artifact) => ({ ...artifact, dimensions: { ...artifact.dimensions }, tags: [...artifact.tags] })),
      zones: parsed.zones.map((zone) => ({ ...zone, artifactIds: [...zone.artifactIds] })),
      issues: parsed.issues.map((issue) => ({ ...issue })),
      preferences: { ...parsed.preferences },
      ...(parsed.restoredFrom ? { restoredFrom: { ...parsed.restoredFrom } } : {}),
      ...(parsed.lastSavedAt ? { lastSavedAt: parsed.lastSavedAt } : {}),
    };
    collector.add('project', state.project.id, state.project.title, 'kept', 'Project already uses the current format.');
    state.artifacts.forEach((artifact) => collector.add('artifact', artifact.id, artifact.title, 'kept', 'Object record matches the current format.'));
    state.zones.forEach((zone) => collector.add('zone', zone.id, zone.name, 'kept', 'Zone record matches the current format.'));
    state.issues.forEach((issue) => collector.add('issue', issue.id, issue.title, 'kept', 'Review finding matches the current format.'));
    collector.add('preferences', 'planning', 'Planning preferences', 'kept', 'Preferences match the current format.');
  }

  const collisionResult = repairCollisions(state, collector);
  state = scanReferences(collisionResult.state, collector);

  const report: MigrationReport = {
    sourceVersion: detection.version,
    sourceFormat: detection.format,
    steps,
    entries: collector.entries,
  };
  return {
    ok: true,
    plan: { report, state, counters: countEntries(report.entries), idAliases: collisionResult.aliases },
  };
}

/** Apply reviewer decisions to a plan and return the resulting state. */
export function applyReviewDecisions(plan: MigrationPlan, decisions: ReviewDecisions = {}): AppliedMigration {
  const droppedArtifacts = new Set<string>();
  const droppedZones = new Set<string>();
  const droppedIssues = new Set<string>();
  let confirmedCount = 0;

  const resolve = (id: string) => plan.idAliases[id] ?? id;

  for (const candidate of plan.report.entries) {
    if (candidate.recordType !== 'artifact' && candidate.recordType !== 'zone' && candidate.recordType !== 'issue') continue;
    const chosen = candidate.adjustable ? (decisions[candidate.id] ?? candidate.decision) : candidate.decision;
    if (candidate.adjustable && decisions[candidate.id] !== undefined) confirmedCount += 1;
    if (chosen !== 'drop') continue;
    const resolvedId = resolve(candidate.recordId);
    if (candidate.recordType === 'artifact') droppedArtifacts.add(resolvedId);
    if (candidate.recordType === 'zone') droppedZones.add(resolvedId);
    if (candidate.recordType === 'issue') droppedIssues.add(resolvedId);
  }

  let state: WorkspaceState = {
    ...plan.state,
    artifacts: plan.state.artifacts.filter((artifact) => !droppedArtifacts.has(artifact.id)),
    zones: plan.state.zones
      .filter((zone) => !droppedZones.has(zone.id))
      .map((zone) => ({ ...zone, artifactIds: zone.artifactIds.filter((id) => !droppedArtifacts.has(id)) })),
    issues: plan.state.issues
      .filter((issue) => !droppedIssues.has(issue.id))
      .map((issue) => ({
        ...issue,
        zoneId: issue.zoneId && droppedZones.has(issue.zoneId) ? undefined : issue.zoneId,
        artifactId: issue.artifactId && droppedArtifacts.has(issue.artifactId) ? undefined : issue.artifactId,
      })),
  };

  // Dropping a reviewed record can strand links; the shared reference scan
  // cleans them deterministically without adding new report rows.
  state = scanReferences(state, null);
  return { state, report: plan.report, counters: plan.counters, confirmedCount };
}

/* ------------------------------------------------------------------ */
/* Structural validation (shared by seed, loads, and recovery)         */
/* ------------------------------------------------------------------ */

/**
 * The single structural validation path used by the sample plan, workspace
 * loads, and the recovery writer. Returns human-readable problems; an empty
 * array means the state is safe to persist and use.
 */
export function findWorkspaceShapeErrors(value: unknown): string[] {
  const errors: string[] = [];
  const root = asRecord(value);
  if (!root) return ['Workspace is not an object.'];
  if (root.version !== CURRENT_WORKSPACE_VERSION) errors.push(`Unsupported workspace version: ${String(root.version)}.`);

  const project = asRecord(root.project);
  if (!project) {
    errors.push('Project section is missing.');
  } else {
    for (const field of ['id', 'title', 'venue', 'audience'] as const) {
      if (typeof project[field] !== 'string' || !(project[field] as string).trim()) errors.push(`Project ${field} is missing or empty.`);
    }
    if (!STAGES.includes(project.stage as ProjectStage)) errors.push(`Project stage "${String(project.stage)}" is invalid.`);
    if (project.openingDate !== undefined && project.openingDate !== '' && Number.isNaN(Date.parse(project.openingDate as string))) {
      errors.push('Project opening date is not a valid date.');
    }
  }

  const preferences = asRecord(root.preferences);
  if (!preferences) {
    errors.push('Preferences section is missing.');
  } else {
    if (!PACES.includes(preferences.pace as PlanningPreferences['pace'])) errors.push('Planning pace is invalid.');
    if (!isFiniteNumber(preferences.accessibilityPriority) || preferences.accessibilityPriority < 0 || preferences.accessibilityPriority > 100) {
      errors.push('Accessibility priority must be between 0 and 100.');
    }
    if (!isFiniteNumber(preferences.groupSize) || preferences.groupSize < 1 || preferences.groupSize > 30) {
      errors.push('Group size must be between 1 and 30.');
    }
    if (preferences.targetVisitMinutes !== null && (!isFiniteNumber(preferences.targetVisitMinutes) || preferences.targetVisitMinutes <= 0)) {
      errors.push('Target visit length must be a positive number or unset.');
    }
  }

  const artifacts = Array.isArray(root.artifacts) ? root.artifacts as unknown[] : null;
  const zones = Array.isArray(root.zones) ? root.zones as unknown[] : null;
  const issues = Array.isArray(root.issues) ? root.issues as unknown[] : null;
  if (!artifacts) errors.push('Artifacts section must be an array.');
  if (!zones) errors.push('Zones section must be an array.');
  if (!issues) errors.push('Issues section must be an array.');

  if (artifacts) {
    const ids = new Set<string>();
    const accessions = new Set<string>();
    artifacts.forEach((rawArtifact, index) => {
      const record = asRecord(rawArtifact);
      const where = `Artifacts[${index}]`;
      if (!record) { errors.push(`${where} is not an object.`); return; }
      if (typeof record.id !== 'string' || !record.id) errors.push(`${where} is missing an ID.`);
      else if (ids.has(record.id)) errors.push(`${where} duplicates artifact ID "${record.id}".`);
      else ids.add(record.id);
      if (typeof record.title !== 'string' || !record.title.trim()) errors.push(`${where} is missing a title.`);
      const accession = typeof record.accessionId === 'string' ? normalizeAccessionId(record.accessionId) : '';
      if (!accession) errors.push(`${where} is missing an accession ID.`);
      else if (accessions.has(accession)) errors.push(`${where} duplicates accession ID "${accession}".`);
      else accessions.add(accession);
      if (!isFiniteNumber(record.dwellMinutes) || record.dwellMinutes <= 0) errors.push(`${where} has an invalid dwell time.`);
      const dimensions = asRecord(record.dimensions);
      if (!dimensions || !isFiniteNumber(dimensions.width) || dimensions.width <= 0
        || !isFiniteNumber(dimensions.height) || dimensions.height <= 0
        || !isFiniteNumber(dimensions.depth) || dimensions.depth <= 0) {
        errors.push(`${where} has invalid dimensions.`);
      }
      if (!ROLES.includes(record.narrativeRole as NarrativeRole)) errors.push(`${where} has an invalid narrative role.`);
      if (!SENSITIVITIES.includes(record.sensitivity as Sensitivity)) errors.push(`${where} has an invalid sensitivity.`);
      if (!ACCESS_NEEDS.includes(record.accessibilityNeed as AccessibilityNeed)) errors.push(`${where} has an invalid accessibility need.`);
      if (typeof record.isKeyObject !== 'boolean') errors.push(`${where} is missing the key-object flag.`);
      if (!Array.isArray(record.tags)) errors.push(`${where} tags must be an array.`);
    });
  }

  if (zones && artifacts) {
    const artifactIds = new Set((artifacts as Record<string, unknown>[]).map((record) => record.id as string));
    const zoneIds = new Set<string>();
    zones.forEach((rawZone, index) => {
      const record = asRecord(rawZone);
      const where = `Zones[${index}]`;
      if (!record) { errors.push(`${where} is not an object.`); return; }
      if (typeof record.id !== 'string' || !record.id) errors.push(`${where} is missing an ID.`);
      else if (zoneIds.has(record.id)) errors.push(`${where} duplicates zone ID "${record.id}".`);
      else zoneIds.add(record.id);
      if (typeof record.name !== 'string' || !record.name.trim()) errors.push(`${where} is missing a name.`);
      if (!isFiniteNumber(record.sequence)) errors.push(`${where} has an invalid sequence.`);
      if (!isFiniteNumber(record.capacityMinutes) || record.capacityMinutes <= 0) errors.push(`${where} has an invalid dwell capacity.`);
      if (!isFiniteNumber(record.maxObjects) || record.maxObjects <= 0) errors.push(`${where} has an invalid object limit.`);
      if (!Array.isArray(record.artifactIds)) { errors.push(`${where} placements must be an array.`); return; }
      for (const ref of record.artifactIds as unknown[]) {
        if (typeof ref !== 'string' || !artifactIds.has(ref)) errors.push(`${where} references unknown artifact "${String(ref)}".`);
      }
    });

    if (issues) {
      issues.forEach((rawIssue, index) => {
        const record = asRecord(rawIssue);
        const where = `Issues[${index}]`;
        if (!record) { errors.push(`${where} is not an object.`); return; }
        if (typeof record.id !== 'string' || !record.id) errors.push(`${where} is missing an ID.`);
        if (typeof record.title !== 'string' || !record.title.trim()) errors.push(`${where} is missing a title.`);
        if (!SEVERITIES.includes(record.severity as IssueSeverity)) errors.push(`${where} has an invalid severity.`);
        if (!STATUSES.includes(record.status as IssueStatus)) errors.push(`${where} has an invalid status.`);
        if (record.zoneId !== undefined && (!record.zoneId || !zoneIds.has(record.zoneId as string))) {
          errors.push(`${where} references an unknown zone.`);
        }
        if (record.artifactId !== undefined && (!record.artifactId || !artifactIds.has(record.artifactId as string))) {
          errors.push(`${where} references an unknown artifact.`);
        }
      });
    }
  }

  return errors;
}

/* ------------------------------------------------------------------ */
/* Backwards-compatible silent loader                                  */
/* ------------------------------------------------------------------ */

/**
 * Best-effort migration used when reading storage on startup. Applies safe
 * default decisions (keep salvageable records, drop corrupt ones) so the
 * behavior matches older builds: recognizable workspaces open; junk returns
 * null so the caller can fall back to the seed plan.
 */
export function migrateWorkspace(value: unknown): WorkspaceState | null {
  const result = buildMigrationPlan(value);
  if (!result.ok) return null;
  const applied = applyReviewDecisions(result.plan);
  return findWorkspaceShapeErrors(applied.state).length === 0 ? applied.state : null;
}
