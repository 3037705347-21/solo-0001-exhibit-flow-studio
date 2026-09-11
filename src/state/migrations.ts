import {
  WORKSPACE_SCHEMA_VERSION,
  type WorkspaceState,
  type WorkspaceFile,
} from '../domain/models';
import {
  normalizeWorkspaceShape,
  repairBrokenReferences,
  type StructuralIssue,
  type WorkspaceRecordKind,
} from '../domain/workspaceValidation';

/* ---------------------------------- types --------------------------------- */

export type ChangeOutcome = 'added' | 'kept' | 'invalidated' | 'confirm';
export type ConfirmResolution = 'keep-with-dropped-link' | 'drop-record';

export interface MigrationChange {
  stageId: string;
  recordKind: WorkspaceRecordKind | 'collection' | 'field';
  recordId?: string;
  label: string;
  outcome: ChangeOutcome;
  detail: string;
}

export interface PendingConfirmation {
  id: string;
  recordKind: Extract<WorkspaceRecordKind, 'zone' | 'issue'>;
  recordId: string;
  recordLabel: string;
  target: 'zone.artifactIds' | 'issue.zoneId' | 'issue.artifactId';
  brokenReference: string;
  detail: string;
}

export interface MigrationStepReport {
  stageId: string;
  fromVersion: number;
  toVersion: number;
  title: string;
  description: string;
  changes: MigrationChange[];
}

export interface MigrationPlan {
  sourceVersion: number;
  targetVersion: number;
  recognized: boolean;
  wrappedExport: boolean;
  exportedAt?: string;
  steps: MigrationStepReport[];
  changes: MigrationChange[];
  confirmations: PendingConfirmation[];
  issues: StructuralIssue[];
  fatal: StructuralIssue[];
  candidate: WorkspaceState | null;
}

const LEGACY_STAGE = 'legacy-v0-to-v1';
const PREFERENCES_STAGE = 'preferences-v1-to-v2';
const INTEGRITY_STAGE = 'integrity-check';

const V2_PREFERENCE_DEFAULTS = {
  transitionBufferMinutes: 3,
  showTransitionCues: true,
} as const;

/* ------------------------------ file unwrapping ---------------------------- */

/**
 * Accepts both the current export {@link WorkspaceFile} envelope and a bare
 * workspace object (older exports and storage dumps were bare). Snapshot files
 * are rejected so a read-only snapshot cannot masquerade as a workspace.
 */
export function unwrapWorkspaceFile(value: unknown): { raw: Record<string, unknown>; wrappedExport: boolean; exportedAt?: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'exhibit-flow-workspace') {
    const file = value as Partial<WorkspaceFile>;
    if (file.fileVersion !== 1 || typeof file.workspace !== 'object' || file.workspace === null) return null;
    return { raw: file.workspace as unknown as Record<string, unknown>, wrappedExport: true, exportedAt: file.exportedAt };
  }
  // A readiness snapshot uses schemaVersion; it is not restorable as a workspace.
  if ('schemaVersion' in candidate && !('version' in candidate)) return null;
  return { raw: candidate, wrappedExport: false };
}

export function detectSourceVersion(raw: Record<string, unknown>): { version: number; recognized: boolean } {
  const version = raw.version;
  if (version === undefined) return { version: 0, recognized: true };
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0 || version > WORKSPACE_SCHEMA_VERSION) {
    return { version: typeof version === 'number' ? version : NaN, recognized: false };
  }
  return { version, recognized: true };
}

/* ----------------------------- record labelling ---------------------------- */

function recordLabel(kind: WorkspaceRecordKind, raw: Record<string, unknown>, fallback: string): string {
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  if (kind === 'artifact') return text(raw.title) ?? text(raw.accessionId) ?? fallback;
  if (kind === 'zone') return text(raw.name) ?? text(raw.shortLabel) ?? fallback;
  if (kind === 'issue') return text(raw.title) ?? fallback;
  if (kind === 'project') return text(raw.title) ?? fallback;
  return 'Planning preferences';
}

function asRecordArray(raw: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = raw[key];
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null) : [];
}

/* ------------------------------- migration -------------------------------- */

function buildFatalPlan(sourceVersion: number, wrappedExport: boolean, exportedAt: string | undefined, fatal: StructuralIssue[]): MigrationPlan {
  return {
    sourceVersion,
    targetVersion: WORKSPACE_SCHEMA_VERSION,
    recognized: sourceVersion >= 0,
    wrappedExport,
    exportedAt,
    steps: [],
    changes: [],
    confirmations: [],
    issues: [],
    fatal,
    candidate: null,
  };
}

/**
 * Plans the migration of an imported or stored workspace. The returned plan is
 * pure and side-effect free: it describes every ordered migration step, the
 * reviewable record changes (added / kept / invalidated / confirm), and a
 * candidate state. Nothing is written until {@link applyConfirmations} and a
 * transactional restore run.
 */
export function planWorkspaceMigration(value: unknown): MigrationPlan {
  const unwrapped = unwrapWorkspaceFile(value);
  if (!unwrapped) {
    return buildFatalPlan(NaN, false, undefined, [{
      code: 'unrecognized-file',
      message: 'This file is not a workspace export (it may be a read-only snapshot).',
      path: '$',
      repairable: false,
    }]);
  }
  const { raw, wrappedExport, exportedAt } = unwrapped;
  const { version: sourceVersion, recognized } = detectSourceVersion(raw);
  if (!recognized) {
    return buildFatalPlan(sourceVersion, wrappedExport, exportedAt, [{
      code: 'unknown-version',
      message: `Workspace schema version ${raw.version} is from a newer or unknown release and cannot be read safely.`,
      path: '$.version',
      repairable: false,
    }]);
  }

  const steps: MigrationStepReport[] = [];
  const changes: MigrationChange[] = [];
  let working: Record<string, unknown> = { ...raw };

  // Step 0 -> 1: legacy normalization (zone sequence positions).
  if (sourceVersion < 1) {
    const stepChanges: MigrationChange[] = [];
    const legacyZones = asRecordArray(working, 'zones');
    const migratedZones = legacyZones.map((zone, index) => {
      if (typeof zone.sequence !== 'number') {
        stepChanges.push({
          stageId: LEGACY_STAGE,
          recordKind: 'field',
          recordId: typeof zone.id === 'string' ? zone.id : undefined,
          label: `${recordLabel('zone', zone, `Zone ${index + 1}`)} · sequence`,
          outcome: 'added',
          detail: 'Legacy zones had no explicit visit order; the file position was used.',
        });
      }
      return { ...zone, sequence: typeof zone.sequence === 'number' ? zone.sequence : index };
    });
    // Record-level kept/invalidated decisions are reported by the final
    // integrity stage so each record appears exactly once in the review.
    working = { ...working, version: 1, zones: migratedZones };
    steps.push({
      stageId: LEGACY_STAGE,
      fromVersion: 0,
      toVersion: 1,
      title: 'Legacy workspace normalization',
      description: 'Version 0 exports lacked explicit zone ordering; positions are derived from file order.',
      changes: stepChanges,
    });
    changes.push(...stepChanges);
  }

  // Step 1 -> 2: planning preferences expansion.
  if (sourceVersion < 2) {
    const stepChanges: MigrationChange[] = [];
    const preferences = (working.preferences && typeof working.preferences === 'object' ? working.preferences : {}) as Record<string, unknown>;
    const nextPreferences = { ...preferences };
    if (typeof preferences.transitionBufferMinutes !== 'number') {
      nextPreferences.transitionBufferMinutes = V2_PREFERENCE_DEFAULTS.transitionBufferMinutes;
      stepChanges.push({ stageId: PREFERENCES_STAGE, recordKind: 'field', label: 'Planning preferences · transitionBufferMinutes', outcome: 'added', detail: `New preference defaulting to ${V2_PREFERENCE_DEFAULTS.transitionBufferMinutes} minutes between zones.` });
    }
    if (typeof preferences.showTransitionCues !== 'boolean') {
      nextPreferences.showTransitionCues = V2_PREFERENCE_DEFAULTS.showTransitionCues;
      stepChanges.push({ stageId: PREFERENCES_STAGE, recordKind: 'field', label: 'Planning preferences · showTransitionCues', outcome: 'added', detail: 'New preference defaulting to enabled transition cues.' });
    }
    working = { ...working, version: 2, preferences: nextPreferences };
    steps.push({
      stageId: PREFERENCES_STAGE,
      fromVersion: 1,
      toVersion: 2,
      title: 'Planning preferences expansion',
      description: 'Version 2 stores inter-zone pacing and transition cue preferences.',
      changes: stepChanges,
    });
    changes.push(...stepChanges);
  }

  // Final stage: the shared structural validation path.
  const normalized = normalizeWorkspaceShape(working);
  if (!normalized) {
    return buildFatalPlan(sourceVersion, wrappedExport, exportedAt, [{
      code: 'shape',
      message: 'The file does not contain a workspace object.',
      path: '$',
      repairable: false,
    }]);
  }
  const integrityChanges: MigrationChange[] = [];
  if (normalized.state === null) {
    return buildFatalPlan(sourceVersion, wrappedExport, exportedAt, normalized.issues.filter((issue) => !issue.repairable));
  }
  const candidate = normalized.state;

  // Structural repairs become "added" (a default filled a gap) and dropped
  // records become "invalidated".
  const droppedIds = new Set(normalized.issues.filter((issue) => !issue.repairable && issue.recordId).map((issue) => issue.recordId as string));
  for (const issue of normalized.issues) {
    if (issue.code.startsWith('missing-') && issue.code !== 'missing-project') {
      integrityChanges.push({ stageId: INTEGRITY_STAGE, recordKind: 'collection', label: issue.message.replace(/;.*$/, ''), outcome: 'added', detail: issue.message });
    } else if (!issue.repairable && issue.recordKind && issue.recordId) {
      if (droppedIds.has(issue.recordId)) {
        integrityChanges.push({ stageId: INTEGRITY_STAGE, recordKind: issue.recordKind, recordId: issue.recordId, label: issue.message.split('"')[1] ?? issue.recordId, outcome: 'invalidated', detail: issue.message });
      }
    } else if (issue.repairable && issue.recordKind && issue.recordId) {
      integrityChanges.push({ stageId: INTEGRITY_STAGE, recordKind: issue.recordKind, recordId: issue.recordId, label: issue.message, outcome: 'added', detail: issue.message });
    } else if (issue.repairable) {
      integrityChanges.push({ stageId: INTEGRITY_STAGE, recordKind: 'field', label: issue.message, outcome: 'added', detail: issue.message });
    }
  }

  // Reference integrity: every dangling reference needs a human decision.
  const confirmations: PendingConfirmation[] = [];
  const recordsWithConfirmations = new Set<string>();
  const artifactIds = new Set(candidate.artifacts.map((artifact) => artifact.id));
  const zoneIds = new Set(candidate.zones.map((zone) => zone.id));
  const zoneLabels = new Map(candidate.zones.map((zone) => [zone.id, zone.name]));
  const issueLabels = new Map(candidate.issues.map((issue) => [issue.id, issue.title]));

  candidate.zones.forEach((zone) => {
    const missing = zone.artifactIds.filter((id) => !artifactIds.has(id));
    missing.forEach((ref) => {
      const id = `zone:${zone.id}:${ref}:zone.artifactIds`;
      confirmations.push({
        id,
        recordKind: 'zone',
        recordId: zone.id,
        recordLabel: zone.name,
        target: 'zone.artifactIds',
        brokenReference: ref,
        detail: `Zone "${zone.name}" places object "${ref}", which is not present in the file.`,
      });
      recordsWithConfirmations.add(`zone:${zone.id}`);
    });
  });
  candidate.issues.forEach((issue) => {
    if (issue.zoneId && !zoneIds.has(issue.zoneId)) {
      confirmations.push({
        id: `issue:${issue.id}:${issue.zoneId}:issue.zoneId`,
        recordKind: 'issue',
        recordId: issue.id,
        recordLabel: issue.title,
        target: 'issue.zoneId',
        brokenReference: issue.zoneId,
        detail: `Finding "${issue.title}" links to zone "${issue.zoneId}", which is not present in the file.`,
      });
      recordsWithConfirmations.add(`issue:${issue.id}`);
    }
    if (issue.artifactId && !artifactIds.has(issue.artifactId)) {
      confirmations.push({
        id: `issue:${issue.id}:${issue.artifactId}:issue.artifactId`,
        recordKind: 'issue',
        recordId: issue.id,
        recordLabel: issue.title,
        target: 'issue.artifactId',
        brokenReference: issue.artifactId,
        detail: `Finding "${issue.title}" links to object "${issue.artifactId}", which is not present in the file.`,
      });
      recordsWithConfirmations.add(`issue:${issue.id}`);
    }
  });
  for (const confirmation of confirmations) {
    integrityChanges.push({
      stageId: INTEGRITY_STAGE,
      recordKind: confirmation.recordKind,
      recordId: confirmation.recordId,
      label: confirmation.recordLabel,
      outcome: 'confirm',
      detail: confirmation.detail,
    });
  }

  // Every surviving record without an open decision is kept.
  const keptKinds: Array<['project' | 'preferences' | 'artifacts' | 'zones' | 'issues', WorkspaceRecordKind]> = [
    ['project', 'project'],
    ['preferences', 'preferences'],
    ['artifacts', 'artifact'],
    ['zones', 'zone'],
    ['issues', 'issue'],
  ];
  for (const [key, kind] of keptKinds) {
    if (key === 'project') {
      if (!recordsWithConfirmations.has('project')) {
        integrityChanges.push({ stageId: INTEGRITY_STAGE, recordKind: 'project', recordId: candidate.project.id, label: candidate.project.title, outcome: 'kept', detail: 'Project record is complete.' });
      }
      continue;
    }
    if (key === 'preferences') {
      integrityChanges.push({ stageId: INTEGRITY_STAGE, recordKind: 'preferences', label: 'Planning preferences', outcome: 'kept', detail: 'Planning preferences are complete.' });
      continue;
    }
    const list = candidate[key] as Array<{ id: string }>;
    for (const record of list) {
      if (recordsWithConfirmations.has(`${kind}:${record.id}`) || droppedIds.has(record.id)) continue;
      const label = kind === 'artifact'
        ? candidate.artifacts.find((entry) => entry.id === record.id)?.title
        : kind === 'zone' ? zoneLabels.get(record.id) : issueLabels.get(record.id);
      integrityChanges.push({ stageId: INTEGRITY_STAGE, recordKind: kind, recordId: record.id, label: label ?? record.id, outcome: 'kept', detail: 'Validated with no changes.' });
    }
  }

  steps.push({
    stageId: INTEGRITY_STAGE,
    fromVersion: Math.max(sourceVersion, 0),
    toVersion: WORKSPACE_SCHEMA_VERSION,
    title: 'Structure and reference integrity',
    description: 'Every record is checked through the same validation path used by local storage and the sample plan.',
    changes: integrityChanges,
  });
  changes.push(...integrityChanges);

  return {
    sourceVersion,
    targetVersion: WORKSPACE_SCHEMA_VERSION,
    recognized: true,
    wrappedExport,
    exportedAt,
    steps,
    changes,
    confirmations,
    issues: normalized.issues,
    fatal: normalized.issues.filter((issue) => !issue.repairable && issue.path === '$'),
    candidate,
  };
}

/**
 * Applies the reviewer's decisions for every {@link PendingConfirmation} and
 * returns the finalized, reference-safe workspace. Cascading references (for
 * example a finding linked to a zone the reviewer dropped) are cleaned
 * automatically as part of the same decision set.
 */
export function applyConfirmations(
  plan: MigrationPlan,
  resolutions: Record<string, ConfirmResolution>,
): WorkspaceState {
  if (!plan.candidate) throw new Error('This migration plan has no usable candidate state.');
  const pending = plan.confirmations;
  if (pending.some((confirmation) => !resolutions[confirmation.id])) {
    throw new Error('Every flagged record needs a decision before the restore can run.');
  }
  const droppedZoneIds = new Set<string>();
  const droppedIssueIds = new Set<string>();
  const zoneRefsToDrop = new Map<string, Set<string>>();
  const issueRefsToDrop = new Map<string, Set<string>>();

  for (const confirmation of pending) {
    const resolution = resolutions[confirmation.id];
    if (resolution === 'drop-record') {
      if (confirmation.recordKind === 'zone') droppedZoneIds.add(confirmation.recordId);
      else droppedIssueIds.add(confirmation.recordId);
    } else if (confirmation.target === 'zone.artifactIds') {
      const set = zoneRefsToDrop.get(confirmation.recordId) ?? new Set<string>();
      set.add(confirmation.brokenReference);
      zoneRefsToDrop.set(confirmation.recordId, set);
    } else {
      const set = issueRefsToDrop.get(confirmation.recordId) ?? new Set<string>();
      set.add(confirmation.brokenReference);
      issueRefsToDrop.set(confirmation.recordId, set);
    }
  }

  let state: WorkspaceState = {
    ...plan.candidate,
    zones: plan.candidate.zones
      .filter((zone) => !droppedZoneIds.has(zone.id))
      .map((zone) => ({ ...zone, artifactIds: zone.artifactIds.filter((id) => !(zoneRefsToDrop.get(zone.id)?.has(id))) })),
    issues: plan.candidate.issues
      .filter((issue) => !droppedIssueIds.has(issue.id))
      .map((issue) => {
        const drop = issueRefsToDrop.get(issue.id);
        if (!drop) return issue;
        return {
          ...issue,
          zoneId: drop.has(issue.zoneId ?? '') ? undefined : issue.zoneId,
          artifactId: drop.has(issue.artifactId ?? '') ? undefined : issue.artifactId,
        };
      }),
  };
  // Dropping a zone cascades to finding links.
  state = repairBrokenReferences(state);
  return state;
}

/* --------------------------- non-interactive path -------------------------- */

/**
 * Automatic migration used when loading local storage: no reviewer is present,
 * so broken references are dropped exactly like the previous implementation
 * did (old read behavior must not regress). Returns null when nothing in the
 * file is safe to use.
 */
export function migrateWorkspace(value: unknown): WorkspaceState | null {
  const plan = planWorkspaceMigration(value);
  if (!plan.candidate) return null;
  const resolutions: Record<string, ConfirmResolution> = {};
  for (const confirmation of plan.confirmations) resolutions[confirmation.id] = 'keep-with-dropped-link';
  const state = applyConfirmations(plan, resolutions);
  return state;
}

/** Backwards-compatible name; startup storage loads silently prune dangling refs. */
export function validateReferences(state: WorkspaceState): WorkspaceState {
  return repairBrokenReferences(state);
}

export function isPlanResolved(plan: MigrationPlan, resolutions: Record<string, ConfirmResolution>): boolean {
  return plan.confirmations.every((confirmation) => Boolean(resolutions[confirmation.id]));
}
