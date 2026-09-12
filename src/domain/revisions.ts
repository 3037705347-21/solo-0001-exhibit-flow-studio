import { titleCase } from './formatters';
import { createId, normalizeAccessionId } from './ids';
import type { Artifact, ArtifactRevision, Dimensions, RevisionFieldChange, RevisionKind } from './models';

/**
 * Object metadata fields tracked by the revision chain. Identity and
 * bookkeeping fields (id, createdAt, updatedAt, revision) are excluded so a
 * restore can never fork the object identity that placements, findings, and
 * exports reference.
 */
export const TRACKED_ARTIFACT_FIELDS = [
  'accessionId',
  'title',
  'maker',
  'yearLabel',
  'medium',
  'origin',
  'summary',
  'dimensions',
  'dwellMinutes',
  'narrativeRole',
  'sensitivity',
  'accessibilityNeed',
  'isKeyObject',
  'tags',
  'color',
] as const;

export type TrackedArtifactField = (typeof TRACKED_ARTIFACT_FIELDS)[number];

export const REVISION_FIELD_LABELS: Record<TrackedArtifactField, string> = {
  accessionId: 'Accession ID',
  title: 'Title',
  maker: 'Maker / source',
  yearLabel: 'Date / period',
  medium: 'Medium',
  origin: 'Origin',
  summary: 'Summary',
  dimensions: 'Dimensions',
  dwellMinutes: 'Dwell time',
  narrativeRole: 'Narrative role',
  sensitivity: 'Sensitivity',
  accessibilityNeed: 'Accessibility need',
  isKeyObject: 'Key object',
  tags: 'Tags',
  color: 'Color',
};

export class RevisionConflictError extends Error {
  constructor(
    public readonly currentVersion: number,
    public readonly baseVersion: number | undefined,
  ) {
    super(
      baseVersion === undefined
        ? 'Editing this object requires the version it was loaded from.'
        : `This object is now at version ${currentVersion}, but the change was based on version ${baseVersion}. Reload the latest record before saving.`,
    );
    this.name = 'RevisionConflictError';
  }
}

export function isTrackedField(field: string): field is TrackedArtifactField {
  return (TRACKED_ARTIFACT_FIELDS as readonly string[]).includes(field);
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) =>
    valuesEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

export function cloneArtifact(artifact: Artifact): Artifact {
  return cloneValue(artifact);
}

/** Field-level before/after diff across every tracked metadata field. */
export function diffArtifacts(before: Artifact | undefined, after: Artifact): RevisionFieldChange[] {
  return TRACKED_ARTIFACT_FIELDS.flatMap((field) => {
    const previous = before ? before[field] : undefined;
    const next = after[field];
    if (before && valuesEqual(previous, next)) return [];
    return [{
      field,
      before: previous === undefined ? undefined : cloneValue(previous),
      after: cloneValue(next),
    }];
  });
}

/**
 * Appends an entry to an object's revision chain. The entry version always
 * matches the version stamped on the `after` artifact, so the chain and the
 * current record can never disagree about which version is current.
 */
export function createRevisionEntry(options: {
  artifactId: string;
  after: Artifact;
  before?: Artifact;
  reason: string;
  kind: RevisionKind;
  at?: Date;
  id?: string;
}): ArtifactRevision {
  return {
    id: options.id ?? createId('revision'),
    artifactId: options.artifactId,
    version: options.after.revision,
    kind: options.kind,
    reason: options.reason.trim(),
    changedAt: (options.at ?? new Date()).toISOString(),
    changes: diffArtifacts(options.before, options.after),
    snapshot: cloneArtifact(options.after),
  };
}

/** Revision chain for one object, ordered oldest to newest. */
export function revisionsForArtifact(revisions: ArtifactRevision[], artifactId: string): ArtifactRevision[] {
  return revisions
    .filter((revision) => revision.artifactId === artifactId)
    .sort((a, b) => a.version - b.version);
}

export function latestRevision(revisions: ArtifactRevision[], artifactId: string): ArtifactRevision | undefined {
  return revisionsForArtifact(revisions, artifactId).at(-1);
}

/**
 * Applies one tracked field from an earlier revision snapshot to the current
 * record. Identity fields are never touched. Returns null when the field
 * already holds the target value, so no empty revision is recorded.
 */
export function applyFieldRestore(
  current: Artifact,
  source: ArtifactRevision,
  field: TrackedArtifactField,
  at = new Date(),
): Artifact | null {
  const target = cloneValue(source.snapshot[field]);
  if (valuesEqual(current[field], target)) return null;
  const next: Artifact = {
    ...current,
    revision: current.revision + 1,
    updatedAt: at.toISOString(),
  };
  (next as unknown as Record<string, unknown>)[field] = target;
  return next;
}

/**
 * Applies a full earlier snapshot to the current record while preserving the
 * object identity (id, createdAt) and advancing the version. Returns null
 * when nothing would change.
 */
export function applyRevisionRestore(
  current: Artifact,
  source: ArtifactRevision,
  at = new Date(),
): Artifact | null {
  const next: Artifact = {
    ...cloneArtifact(source.snapshot),
    id: current.id,
    createdAt: current.createdAt,
    revision: current.revision + 1,
    updatedAt: at.toISOString(),
  };
  return diffArtifacts(current, next).length === 0 ? null : next;
}

/** True when the object's current field value differs from the one captured in `source`. */
export function fieldDiffersFromRevision(current: Artifact, source: ArtifactRevision, field: TrackedArtifactField): boolean {
  return !valuesEqual(current[field], source.snapshot[field]);
}

/** True when restoring `candidate` would collide with another object's accession ID. */
export function hasAccessionCollision(artifacts: Artifact[], candidate: Artifact): boolean {
  const normalized = normalizeAccessionId(candidate.accessionId);
  return artifacts.some(
    (artifact) => artifact.id !== candidate.id && normalizeAccessionId(artifact.accessionId) === normalized,
  );
}

export function formatRevisionValue(field: string, value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (field === 'dimensions' && typeof value === 'object') {
    const dimensions = value as Dimensions;
    return `${dimensions.width} × ${dimensions.height} × ${dimensions.depth} ${dimensions.unit}`;
  }
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (field === 'dwellMinutes') return `${String(value)} min`;
  if (field === 'narrativeRole' || field === 'sensitivity' || field === 'accessibilityNeed') {
    return titleCase(String(value));
  }
  return String(value);
}
