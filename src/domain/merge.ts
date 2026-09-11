import type {
  Artifact,
  Dimensions,
  NarrativeRole,
  ReviewIssue,
  Sensitivity,
  WorkspaceState,
  Zone,
} from './models';
import { normalizeAccessionId } from './ids';

/* ------------------------------------------------------------------ */
/* Incoming payload                                                    */
/* ------------------------------------------------------------------ */

export interface IncomingArtifact {
  accessionId: string;
  title?: unknown;
  maker?: unknown;
  yearLabel?: unknown;
  medium?: unknown;
  origin?: unknown;
  summary?: unknown;
  dimensions?: Partial<Record<'width' | 'height' | 'depth', unknown>> & { unit?: unknown };
  dwellMinutes?: unknown;
  narrativeRole?: unknown;
  sensitivity?: unknown;
  accessibilityNeed?: unknown;
  isKeyObject?: unknown;
  tags?: unknown;
  color?: unknown;
}

export interface IncomingFinding {
  title: unknown;
  description?: unknown;
  severity?: unknown;
  status?: unknown;
  owner?: unknown;
  artifactAccessionId?: unknown;
  zoneShortLabel?: unknown;
}

export interface MergeImportPayload {
  artifacts?: IncomingArtifact[];
  findings?: IncomingFinding[];
}

/* ------------------------------------------------------------------ */
/* Merge plan                                                          */
/* ------------------------------------------------------------------ */

export type MergeFieldKey =
  | 'title'
  | 'maker'
  | 'yearLabel'
  | 'medium'
  | 'origin'
  | 'summary'
  | 'dimensions'
  | 'dwellMinutes'
  | 'narrativeRole'
  | 'sensitivity'
  | 'accessibilityNeed'
  | 'isKeyObject'
  | 'tags'
  | 'color';

export type MergeResolution = 'current' | 'incoming';
export type MergeDecision = 'keep-current' | 'take-incoming' | 'accept-merged' | 'skip';
/** How an actionable finding entry (new / reference-conflict / orphan) is handled. */
export type FindingEntryResolution = 'import' | 'drop-link' | 'skip';

export interface FieldConflict {
  field: MergeFieldKey;
  label: string;
  current: string;
  incoming: string;
  merged: string;
  resolution: MergeResolution;
  /** False until the user has actively chosen a side or accepted the merge. */
  decided: boolean;
}

export type ArtifactMatchKind = 'new' | 'identical' | 'conflict';
export type FindingMergeKind = 'new' | 'identical' | 'field-conflict' | 'reference-conflict' | 'orphan';

export interface ArtifactMergeEntry {
  key: string;
  accessionId: string;
  kind: ArtifactMatchKind;
  current?: Artifact;
  incomingNormalized?: Artifact;
  incomingRaw?: IncomingArtifact;
  /** What happens to an incoming record with no current counterpart. Defaults to import. */
  entryResolution?: 'import' | 'skip';
  merged?: Artifact;
  decision?: MergeDecision;
  fields: FieldConflict[];
}

export interface FindingMergeEntry {
  key: string;
  kind: FindingMergeKind;
  current?: ReviewIssue;
  incomingRaw: IncomingFinding;
  incomingNormalized?: ReviewIssue;
  /** Object identity (accession id) the incoming finding links to, when given. */
  targetAccessionId?: string;
  /** Zone identity (short label) the incoming finding links to, when given. */
  targetZoneLabel?: string;
  /** Explicit choice for actionable entries: import as-is, drop dangling links, or skip. */
  entryResolution?: FindingEntryResolution;
  merged?: ReviewIssue;
  decision?: MergeDecision;
  fieldConflicts: FieldConflict[];
  detail: string;
}

export interface MergePlan {
  artifactEntries: ArtifactMergeEntry[];
  findingEntries: FindingMergeEntry[];
  parseErrors: string[];
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export const MERGE_FIELD_LABELS: Record<MergeFieldKey, string> = {
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
  color: 'Swatch',
};

const ROLES: NarrativeRole[] = ['threshold', 'context', 'turning-point', 'reflection'];
const SENSITIVITIES: Sensitivity[] = ['standard', 'low-light', 'fragile'];
const NEEDS: Artifact['accessibilityNeed'][] = ['none', 'seating', 'audio', 'tactile-alternative'];
const SEVERITIES: ReviewIssue['severity'][] = ['note', 'warning', 'critical'];
const STATUSES: ReviewIssue['status'][] = ['open', 'in-progress', 'resolved'];

const FIELD_ORDER: MergeFieldKey[] = [
  'title', 'maker', 'yearLabel', 'medium', 'origin', 'summary',
  'dimensions', 'dwellMinutes', 'narrativeRole', 'sensitivity',
  'accessibilityNeed', 'isKeyObject', 'tags', 'color',
];

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean).slice(0, 8);
  }
  if (typeof value === 'string') {
    return value.split(',').map((entry) => entry.trim()).filter(Boolean).slice(0, 8);
  }
  return undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : undefined;
}

function stableStamp(at: string): string {
  return at;
}

/* ------------------------------------------------------------------ */
/* Normalization                                                      */
/* ------------------------------------------------------------------ */

/**
 * Coerce one incoming artifact record into the canonical Artifact shape.
 * Fields that are absent or unreadable are filled from `fallback` (the
 * current record) so the merged result always stays a valid object.
 */
export function normalizeIncomingArtifact(
  raw: IncomingArtifact,
  fallback: Artifact | undefined,
  idFactory: () => string,
  at: string,
): { artifact: Artifact; problems: string[] } {
  const problems: string[] = [];
  const accessionId = normalizeAccessionId(raw.accessionId ?? '');

  const text = (value: unknown, current: string | undefined, label: string): string => {
    const parsed = asTrimmedString(value);
    if (parsed !== undefined) return parsed;
    if (value !== undefined && value !== null) problems.push(`${label} was unreadable and ignored.`);
    return current ?? '';
  };

  const dimSource = raw.dimensions ?? {};
  const dimension = (key: 'width' | 'height' | 'depth', current: number): number => {
    const parsed = asFiniteNumber(dimSource[key]);
    if (parsed === undefined) {
      if (dimSource[key] !== undefined) problems.push(`Dimension ${key} was unreadable and ignored.`);
      return current;
    }
    if (parsed <= 0 || parsed > 10000) {
      problems.push(`Dimension ${key} is outside the supported range and was ignored.`);
      return current;
    }
    return parsed;
  };

  let dwell = asFiniteNumber(raw.dwellMinutes);
  if (raw.dwellMinutes !== undefined) {
    if (dwell === undefined || dwell <= 0 || dwell > 30) {
      problems.push('Dwell time is outside the 1–30 minute range and was ignored.');
      dwell = undefined;
    }
  }

  const role = oneOf(raw.narrativeRole, ROLES);
  if (raw.narrativeRole !== undefined && role === undefined) problems.push('Narrative role was not recognized and was ignored.');
  const sensitivity = oneOf(raw.sensitivity, SENSITIVITIES);
  if (raw.sensitivity !== undefined && sensitivity === undefined) problems.push('Sensitivity was not recognized and was ignored.');
  const need = oneOf(raw.accessibilityNeed, NEEDS);
  if (raw.accessibilityNeed !== undefined && need === undefined) problems.push('Accessibility need was not recognized and was ignored.');

  const tags = asStringArray(raw.tags);
  if (raw.tags !== undefined && tags === undefined) problems.push('Tags were unreadable and ignored.');

  const color = asTrimmedString(raw.color) ?? fallback?.color;
  const keyObject = asBoolean(raw.isKeyObject);
  if (raw.isKeyObject !== undefined && keyObject === undefined) problems.push('Key-object flag was unreadable and ignored.');

  const artifact: Artifact = {
    id: fallback?.id ?? idFactory(),
    accessionId: accessionId || fallback?.accessionId || '',
    title: text(raw.title, fallback?.title, 'Title'),
    maker: text(raw.maker, fallback?.maker, 'Maker'),
    yearLabel: asTrimmedString(raw.yearLabel) ?? fallback?.yearLabel ?? 'Date unknown',
    medium: text(raw.medium, fallback?.medium, 'Medium'),
    origin: asTrimmedString(raw.origin) ?? fallback?.origin ?? 'Origin unknown',
    summary: text(raw.summary, fallback?.summary, 'Summary'),
    dimensions: {
      width: dimension('width', fallback?.dimensions.width ?? 1),
      height: dimension('height', fallback?.dimensions.height ?? 1),
      depth: dimension('depth', fallback?.dimensions.depth ?? 1),
      unit: 'cm',
    },
    dwellMinutes: dwell ?? fallback?.dwellMinutes ?? 3,
    narrativeRole: role ?? fallback?.narrativeRole ?? 'context',
    sensitivity: sensitivity ?? fallback?.sensitivity ?? 'standard',
    accessibilityNeed: need ?? fallback?.accessibilityNeed ?? 'none',
    isKeyObject: keyObject ?? fallback?.isKeyObject ?? false,
    tags: tags ?? fallback?.tags ?? [],
    color: color ?? '#c9563f',
    createdAt: fallback?.createdAt ?? stableStamp(at),
    updatedAt: stableStamp(at),
  };
  return { artifact, problems };
}

export function normalizeIncomingFinding(
  raw: IncomingFinding,
  idFactory: () => string,
  at: string,
  fallback?: ReviewIssue,
): { finding: ReviewIssue; problems: string[] } | { error: string } {
  const problems: string[] = [];
  const title = asTrimmedString(raw.title);
  if (!title) return { error: 'A finding without a title cannot be imported.' };
  const description = asTrimmedString(raw.description) ?? fallback?.description ?? 'Imported finding without additional context.';
  let severity = oneOf(raw.severity, SEVERITIES);
  if (raw.severity !== undefined && severity === undefined) {
    problems.push('Finding severity was not recognized; its value was ignored.');
    severity = undefined;
  }
  severity = severity ?? fallback?.severity ?? 'warning';
  let status = oneOf(raw.status, STATUSES);
  if (raw.status !== undefined && status === undefined) {
    problems.push('Finding status was not recognized; its value was ignored.');
    status = undefined;
  }
  status = status ?? fallback?.status ?? 'open';
  const owner = asTrimmedString(raw.owner) ?? fallback?.owner ?? 'Imported';

  const finding: ReviewIssue = {
    id: fallback?.id ?? idFactory(),
    title,
    description,
    severity,
    status,
    owner,
    zoneId: undefined,
    artifactId: undefined,
    createdAt: fallback?.createdAt ?? at,
    updatedAt: at,
    ...(status === 'resolved' ? { resolvedAt: fallback?.resolvedAt ?? at } : {}),
  };
  return { finding, problems };
}

/* ------------------------------------------------------------------ */
/* Display formatting                                                  */
/* ------------------------------------------------------------------ */

function prettify(value: string): string {
  return value
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function formatFieldValue(artifact: Artifact, field: MergeFieldKey): string {
  switch (field) {
    case 'dimensions':
      return `${artifact.dimensions.width} × ${artifact.dimensions.height} × ${artifact.dimensions.depth} cm`;
    case 'dwellMinutes':
      return `${artifact.dwellMinutes} min`;
    case 'narrativeRole':
    case 'sensitivity':
    case 'accessibilityNeed':
      return prettify(artifact[field]);
    case 'isKeyObject':
      return artifact.isKeyObject ? 'Key object' : 'Standard object';
    case 'tags':
      return artifact.tags.length ? artifact.tags.join(', ') : '—';
    default:
      return artifact[field] || '—';
  }
}

export function formatDimensions(dim: Dimensions): string {
  return `${dim.width} × ${dim.height} × ${dim.depth} cm`;
}

/* ------------------------------------------------------------------ */
/* Field comparison & merge                                            */
/* ------------------------------------------------------------------ */

function valuesDiffer(current: Artifact, incoming: Artifact, field: MergeFieldKey): boolean {
  if (field === 'dimensions') {
    return (['width', 'height', 'depth'] as const).some(
      (key) => current.dimensions[key] !== incoming.dimensions[key],
    );
  }
  if (field === 'tags') {
    const currentTags = [...current.tags].sort();
    const incomingTags = [...incoming.tags].sort();
    return currentTags.length !== incomingTags.length || currentTags.some((tag, index) => tag !== incomingTags[index]);
  }
  const currentValue = current[field];
  const incomingValue = incoming[field];
  if (typeof currentValue === 'object' || typeof incomingValue === 'object') return false;
  return currentValue !== incomingValue;
}

/**
 * Field-level "smart merge": keep the current side unless the incoming side
 * carries a meaningful value that the current record is missing. Equal values
 * stay equal; genuine conflicts remain side-by-side for the user to settle.
 */
function mergeFieldValue(field: MergeFieldKey, current: Artifact, incoming: Artifact): string {
  switch (field) {
    case 'dimensions':
      return formatDimensions({
        width: current.dimensions.width || incoming.dimensions.width,
        height: current.dimensions.height || incoming.dimensions.height,
        depth: current.dimensions.depth || incoming.dimensions.depth,
        unit: 'cm',
      });
    case 'dwellMinutes':
      return `${current.dwellMinutes || incoming.dwellMinutes} min`;
    case 'isKeyObject':
      return (current.isKeyObject || incoming.isKeyObject) ? 'Key object' : 'Standard object';
    case 'tags': {
      const mergedTags = [...new Set([...current.tags, ...incoming.tags])];
      return mergedTags.length ? mergedTags.join(', ') : '—';
    }
    default: {
      const currentValue = current[field] as string;
      const incomingValue = incoming[field] as string;
      const placeholders = ['', 'Date unknown', 'Origin unknown', '—'];
      if (placeholders.includes(currentValue) && !placeholders.includes(incomingValue)) return incomingValue;
      return formatFieldValue(current, field);
    }
  }
}

function buildMergedArtifact(current: Artifact, incoming: Artifact, fields: FieldConflict[]): Artifact {
  const merged: Artifact = {
    ...current,
    dimensions: { ...current.dimensions },
    tags: [...current.tags],
    updatedAt: incoming.updatedAt,
  };
  for (const conflict of fields) {
    if (conflict.field === 'dimensions') {
      const source = conflict.resolution === 'incoming' ? incoming : current;
      merged.dimensions = { ...source.dimensions };
      continue;
    }
    if (conflict.field === 'tags') {
      if (conflict.resolution === 'incoming') merged.tags = [...incoming.tags];
      continue;
    }
    const source = conflict.resolution === 'incoming' ? incoming : current;
    (merged as unknown as Record<string, unknown>)[conflict.field] = (source as unknown as Record<string, unknown>)[conflict.field];
  }
  return merged;
}

function artifactsEqual(a: Artifact, b: Artifact): boolean {
  return FIELD_ORDER.every((field) => !valuesDiffer(a, b, field));
}

/* ------------------------------------------------------------------ */
/* Plan construction                                                   */
/* ------------------------------------------------------------------ */

function buildArtifactEntry(
  raw: IncomingArtifact,
  currentByAccession: Map<string, Artifact>,
  idFactory: () => string,
  at: string,
): { entry: ArtifactMergeEntry; problems: string[] } {
  const accessionId = normalizeAccessionId(raw.accessionId ?? '');
  const key = `artifact:${accessionId || `raw:${raw.title ?? 'unknown'}`}`;
  if (!accessionId) {
    return {
      entry: {
        key,
        accessionId: '(missing accession ID)',
        kind: 'new',
        incomingRaw: raw,
        fields: [],
      },
      problems: ['An incoming object has no accession ID and cannot be merged.'],
    };
  }

  const current = currentByAccession.get(accessionId);
  const { artifact: incomingNormalized, problems } = normalizeIncomingArtifact(raw, current, idFactory, at);

  if (!current) {
    return {
      entry: {
        key,
        accessionId,
        kind: 'new',
        incomingRaw: raw,
        incomingNormalized,
        merged: incomingNormalized,
        fields: [],
      },
      problems,
    };
  }

  if (artifactsEqual(current, incomingNormalized)) {
    return {
      entry: {
        key,
        accessionId,
        kind: 'identical',
        current,
        incomingRaw: raw,
        incomingNormalized,
        merged: current,
        fields: [],
      },
      problems,
    };
  }

  const fields: FieldConflict[] = FIELD_ORDER
    .filter((field) => valuesDiffer(current, incomingNormalized, field))
    .map((field): FieldConflict => ({
      field,
      label: MERGE_FIELD_LABELS[field],
      current: formatFieldValue(current, field),
      incoming: formatFieldValue(incomingNormalized, field),
      merged: mergeFieldValue(field, current, incomingNormalized),
      resolution: 'current',
      decided: false,
    }));

  return {
    entry: {
      key,
      accessionId,
      kind: 'conflict',
      current,
      incomingRaw: raw,
      incomingNormalized,
      merged: buildMergedArtifact(current, incomingNormalized, fields),
      fields,
    },
    problems,
  };
}

const FINDING_TITLE_SEP = '||';

function findingIdentityKey(finding: Pick<ReviewIssue, 'title'>, refs: { artifactAccessionId?: string; zoneLabel?: string }): string {
  return [finding.title.trim().toLowerCase(), refs.artifactAccessionId ?? '', refs.zoneLabel ?? ''].join(FINDING_TITLE_SEP);
}

function currentFindingRefs(
  finding: ReviewIssue,
  artifactById: Map<string, Artifact>,
  zoneById: Map<string, Zone>,
): { artifactAccessionId?: string; zoneLabel?: string } {
  return {
    artifactAccessionId: finding.artifactId ? artifactById.get(finding.artifactId)?.accessionId : undefined,
    zoneLabel: finding.zoneId ? zoneById.get(finding.zoneId)?.shortLabel : undefined,
  };
}

function findingsCarrySameData(a: ReviewIssue, b: ReviewIssue): boolean {
  return a.title === b.title
    && a.description === b.description
    && a.severity === b.severity
    && a.status === b.status
    && a.owner === b.owner;
}

function buildFindingEntry(
  raw: IncomingFinding,
  context: {
    currentByFindingKey: Map<string, ReviewIssue>;
    artifactByAccession: Map<string, Artifact>;
    zoneByLabel: Map<string, Zone>;
    artifactKeys: Set<string>;
  },
  idFactory: () => string,
  at: string,
): { entry: FindingMergeEntry; problems: string[] } {
  const title = asTrimmedString(raw.title) ?? '(untitled finding)';
  const targetAccessionId = asTrimmedString(raw.artifactAccessionId)
    ? normalizeAccessionId(raw.artifactAccessionId as string)
    : undefined;
  const targetZoneLabel = asTrimmedString(raw.zoneShortLabel) ?? undefined;
  const key = `finding:${findingIdentityKey({ title }, { artifactAccessionId: targetAccessionId, zoneLabel: targetZoneLabel })}`;
  const current = context.currentByFindingKey.get(
    findingIdentityKey({ title }, { artifactAccessionId: targetAccessionId, zoneLabel: targetZoneLabel }),
  );
  const normalized = normalizeIncomingFinding(raw, idFactory, at, current);
  const problems = 'problems' in normalized ? normalized.problems : [];

  if ('error' in normalized) {
    return {
      entry: { key, kind: 'orphan', incomingRaw: raw, targetAccessionId, targetZoneLabel, fieldConflicts: [], detail: normalized.error },
      problems: [normalized.error],
    };
  }
  const incomingFinding = normalized.finding;

  // Reference integrity: the incoming finding points at identities absent
  // from both the workspace and the incoming artifact set.
  const referencesKnownArtifact = !targetAccessionId
    || context.artifactByAccession.has(targetAccessionId)
    || context.artifactKeys.has(`artifact:${targetAccessionId}`);
  const referencesKnownZone = !targetZoneLabel || context.zoneByLabel.has(targetZoneLabel.toLowerCase());

  if (!referencesKnownArtifact || !referencesKnownZone) {
    const missing: string[] = [];
    if (!referencesKnownArtifact) missing.push(`object ${targetAccessionId}`);
    if (!referencesKnownZone) missing.push(`zone "${targetZoneLabel}"`);
    return {
      entry: {
        key,
        kind: 'reference-conflict',
        current,
        incomingRaw: raw,
        incomingNormalized: incomingFinding,
        targetAccessionId,
        targetZoneLabel,
        fieldConflicts: [],
        detail: `The incoming finding references ${missing.join(' and ')} that ${missing.length > 1 ? 'do' : 'does'} not exist in either workspace.`,
      },
      problems,
    };
  }

  if (!current) {
    return {
      entry: {
        key,
        kind: 'new',
        incomingRaw: raw,
        incomingNormalized: incomingFinding,
        targetAccessionId,
        targetZoneLabel,
        merged: incomingFinding,
        fieldConflicts: [],
        detail: targetAccessionId || targetZoneLabel ? 'Will be linked after import.' : 'Standalone finding.',
      },
      problems,
    };
  }

  if (findingsCarrySameData(current, incomingFinding)) {
    return {
      entry: {
        key,
        kind: 'identical',
        current,
        incomingRaw: raw,
        incomingNormalized: incomingFinding,
        targetAccessionId,
        targetZoneLabel,
        merged: current,
        fieldConflicts: [],
        detail: 'This finding already exists with identical content and links.',
      },
      problems,
    };
  }

  const incomingTitle = asTrimmedString(raw.title);
  const incomingDescription = asTrimmedString(raw.description);
  const incomingSeverity = oneOf(raw.severity, SEVERITIES);
  const incomingStatus = oneOf(raw.status, STATUSES);
  const incomingOwner = asTrimmedString(raw.owner);

  const fieldDefs: Array<{ field: MergeFieldKey; label: string; current: string; incoming: string }> = [];
  if (incomingDescription !== undefined && incomingDescription !== current.description) {
    fieldDefs.push({ field: 'summary', label: 'Description', current: current.description, incoming: incomingDescription });
  }
  if (incomingSeverity !== undefined && incomingSeverity !== current.severity) {
    fieldDefs.push({ field: 'medium', label: 'Severity', current: prettify(current.severity), incoming: prettify(incomingSeverity) });
  }
  if (incomingStatus !== undefined && incomingStatus !== current.status) {
    fieldDefs.push({ field: 'origin', label: 'Status', current: prettify(current.status), incoming: prettify(incomingStatus) });
  }
  if (incomingOwner !== undefined && incomingOwner !== current.owner) {
    fieldDefs.push({ field: 'maker', label: 'Owner', current: current.owner, incoming: incomingOwner });
  }
  void incomingTitle;
  const fieldConflicts: FieldConflict[] = fieldDefs
    .filter((def) => def.current !== def.incoming)
    .map((def): FieldConflict => ({
      field: def.field,
      label: def.label,
      current: def.current,
      incoming: def.incoming,
      merged: def.current,
      resolution: 'current',
      decided: false,
    }));  return {
    entry: {
      key,
      kind: 'field-conflict',
      current,
      incomingRaw: raw,
      incomingNormalized: incomingFinding,
      targetAccessionId,
      targetZoneLabel,
      merged: current,
      fieldConflicts,
      detail: 'The same finding exists with different field values.',
    },
    problems,
  };
}

/* ------------------------------------------------------------------ */
/* Public API: build / resolve / apply                                 */
/* ------------------------------------------------------------------ */

export function buildMergePlan(
  state: WorkspaceState,
  payload: MergeImportPayload,
  idFactory: () => string = () => `merge-${Math.random().toString(36).slice(2, 10)}`,
  at: string = new Date().toISOString(),
): MergePlan {
  const parseErrors: string[] = [];
  const incomingArtifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
  const incomingFindings = Array.isArray(payload.findings) ? payload.findings : [];
  if (!Array.isArray(payload.artifacts) && payload.artifacts !== undefined) {
    parseErrors.push('The incoming artifact list is malformed and was ignored.');
  }
  if (!Array.isArray(payload.findings) && payload.findings !== undefined) {
    parseErrors.push('The incoming finding list is malformed and was ignored.');
  }

  const currentByAccession = new Map(
    state.artifacts.map((artifact) => [normalizeAccessionId(artifact.accessionId), artifact]),
  );

  const artifactEntries: ArtifactMergeEntry[] = [];
  const seenArtifactKeys = new Set<string>();
  for (const raw of incomingArtifacts) {
    const { entry, problems } = buildArtifactEntry(raw, currentByAccession, idFactory, at);
    if (seenArtifactKeys.has(entry.key)) {
      parseErrors.push(`Duplicate incoming record for ${entry.accessionId} was ignored.`);
      continue;
    }
    seenArtifactKeys.add(entry.key);
    artifactEntries.push(entry);
    parseErrors.push(...problems.map((problem) => `${entry.accessionId}: ${problem}`));
  }

  const artifactById = new Map(state.artifacts.map((artifact) => [artifact.id, artifact]));
  const zoneById = new Map(state.zones.map((zone) => [zone.id, zone]));
  const zoneByLabel = new Map(state.zones.map((zone) => [zone.shortLabel.toLowerCase(), zone]));
  const currentByFindingKey = new Map(
    state.issues.map((issue) => [
      findingIdentityKey(issue, currentFindingRefs(issue, artifactById, zoneById)),
      issue,
    ]),
  );

  const findingEntries: FindingMergeEntry[] = [];
  const seenFindingKeys = new Set<string>();
  for (const raw of incomingFindings) {
    const { entry, problems } = buildFindingEntry(raw, {
      currentByFindingKey,
      artifactByAccession: currentByAccession,
      zoneByLabel,
      artifactKeys: seenArtifactKeys,
    }, idFactory, at);
    if (seenFindingKeys.has(entry.key)) {
      parseErrors.push(`Duplicate incoming finding "${asTrimmedString(raw.title) ?? '(untitled)'}" was ignored.`);
      continue;
    }
    seenFindingKeys.add(entry.key);
    findingEntries.push(entry);
    parseErrors.push(...problems);
  }

  return { artifactEntries, findingEntries, parseErrors };
}

/** Recompute an artifact entry's merged record from its field resolutions. */
export function refreshArtifactMerged(entry: ArtifactMergeEntry): ArtifactMergeEntry {
  if (entry.kind !== 'conflict' || !entry.current || !entry.incomingNormalized) return entry;
  return { ...entry, merged: buildMergedArtifact(entry.current, entry.incomingNormalized, entry.fields) };
}

export function resolveArtifactField(
  plan: MergePlan,
  entryKey: string,
  field: MergeFieldKey,
  resolution: MergeResolution,
): MergePlan {
  return {
    ...plan,
    artifactEntries: plan.artifactEntries.map((entry) => {
      if (entry.key !== entryKey) return entry;
      const fields = entry.fields.map((conflict) =>
        conflict.field === field ? { ...conflict, resolution, decided: true } : conflict,
      );
      return refreshArtifactMerged({ ...entry, fields });
    }),
  };
}

export function setArtifactDecision(plan: MergePlan, entryKey: string, decision: MergeDecision): MergePlan {
  return {
    ...plan,
    artifactEntries: plan.artifactEntries.map((entry) => {
      if (entry.key !== entryKey || entry.kind !== 'conflict') return entry;
      if (decision === 'keep-current') {
        return { ...entry, decision, fields: entry.fields.map((field): FieldConflict => ({ ...field, resolution: 'current', decided: true })), merged: entry.current };
      }
      if (decision === 'take-incoming') {
        const fields = entry.fields.map((field): FieldConflict => ({ ...field, resolution: 'incoming', decided: true }));
        return refreshArtifactMerged({ ...entry, decision, fields });
      }
      // Explicitly accept the smart-merged proposal field by field.
      const fields = entry.fields.map((field) => ({ ...field, decided: true }));
      return refreshArtifactMerged({ ...entry, decision, fields });
    }),
  };
}

export function setFindingDecision(plan: MergePlan, entryKey: string, decision: MergeDecision): MergePlan {
  return {
    ...plan,
    findingEntries: plan.findingEntries.map((entry) => {
      if (entry.key !== entryKey || !entry.current || !entry.incomingNormalized) return entry;
      if (decision === 'keep-current') {
        return { ...entry, decision, fieldConflicts: entry.fieldConflicts.map((field) => ({ ...field, resolution: 'current', decided: true })), merged: entry.current };
      }
      if (decision === 'take-incoming') {
        // Keep the stable id, creation date, and links of the current record.
        return {
          ...entry,
          decision,
          fieldConflicts: entry.fieldConflicts.map((field) => ({ ...field, resolution: 'incoming', decided: true })),
          merged: {
            ...entry.incomingNormalized,
            id: entry.current.id,
            createdAt: entry.current.createdAt,
            zoneId: entry.current.zoneId,
            artifactId: entry.current.artifactId,
          },
        };
      }
      // Explicitly accept the field-by-field merge proposal.
      const fieldConflicts = entry.fieldConflicts.map((field) => ({ ...field, decided: true }));
      const merged: ReviewIssue = { ...entry.current, updatedAt: entry.incomingNormalized.updatedAt };
      for (const conflict of fieldConflicts) {
        const source = conflict.resolution === 'incoming' ? entry.incomingNormalized : entry.current;
        switch (conflict.label) {
          case 'Description': merged.description = source.description; break;
          case 'Severity': merged.severity = source.severity; break;
          case 'Status':
            merged.status = source.status;
            merged.resolvedAt = source.status === 'resolved' ? (source.resolvedAt ?? source.updatedAt) : undefined;
            break;
          case 'Owner': merged.owner = source.owner; break;
        }
      }
      return { ...entry, decision, fieldConflicts, merged };
    }),
  };
}

export function resolveFindingField(
  plan: MergePlan,
  entryKey: string,
  label: string,
  resolution: MergeResolution,
): MergePlan {
  return {
    ...plan,
    findingEntries: plan.findingEntries.map((entry) => {
      if (entry.key !== entryKey || !entry.current || !entry.incomingNormalized) return entry;
      const fieldConflicts = entry.fieldConflicts.map((conflict) =>
        conflict.label === label ? { ...conflict, resolution, decided: true } : conflict,
      );
      // Recompute the merged preview from per-field choices.
      const merged: ReviewIssue = { ...entry.current, updatedAt: entry.incomingNormalized.updatedAt };
      for (const conflict of fieldConflicts) {
        const source = conflict.resolution === 'incoming' ? entry.incomingNormalized : entry.current;
        switch (conflict.label) {
          case 'Description': merged.description = source.description; break;
          case 'Severity': merged.severity = source.severity; break;
          case 'Status':
            merged.status = source.status;
            merged.resolvedAt = source.status === 'resolved' ? (source.resolvedAt ?? source.updatedAt) : undefined;
            break;
          case 'Owner': merged.owner = source.owner; break;
        }
      }
      return { ...entry, fieldConflicts, merged };
    }),
  };
}

export function setFindingEntryResolution(plan: MergePlan, entryKey: string, resolution: FindingEntryResolution): MergePlan {
  return {
    ...plan,
    findingEntries: plan.findingEntries.map((entry) =>
      entry.key === entryKey ? { ...entry, entryResolution: resolution } : entry,
    ),
  };
}

export function setArtifactEntryResolution(plan: MergePlan, entryKey: string, resolution: 'import' | 'skip'): MergePlan {
  return {
    ...plan,
    artifactEntries: plan.artifactEntries.map((entry) =>
      entry.key === entryKey ? { ...entry, entryResolution: resolution } : entry,
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Readiness / completeness                                            */
/* ------------------------------------------------------------------ */

export interface MergePlanStatus {
  totalArtifacts: number;
  conflictingArtifacts: number;
  unresolvedArtifactConflicts: number;
  totalFindings: number;
  conflictingFindings: number;
  unresolvedFindingConflicts: number;
  referenceConflicts: number;
  unresolvedReferenceConflicts: number;
  orphans: number;
  unresolvedOrphans: number;
  newArtifacts: number;
  newFindings: number;
  skipped: number;
  identical: number;
  ready: boolean;
}

export function getMergePlanStatus(plan: MergePlan): MergePlanStatus {
  const conflictingArtifacts = plan.artifactEntries.filter((entry) => entry.kind === 'conflict');
  const fieldConflictFindings = plan.findingEntries.filter((entry) => entry.kind === 'field-conflict');
  const referenceConflicts = plan.findingEntries.filter((entry) => entry.kind === 'reference-conflict');
  const orphans = plan.findingEntries.filter((entry) => entry.kind === 'orphan');
  const unresolvedArtifactConflicts = conflictingArtifacts.filter((entry) =>
    entry.fields.some((field) => !field.decided) || !entry.decision,
  ).length;
  const unresolvedFindingConflicts = fieldConflictFindings.filter((entry) =>
    entry.fieldConflicts.some((field) => !field.decided) || !entry.decision,
  ).length;
  const unresolvedReferenceConflicts = referenceConflicts.filter((entry) => !entry.entryResolution).length;
  const unresolvedOrphans = orphans.filter((entry) => !entry.entryResolution).length;
  const skipped = plan.artifactEntries.filter((entry) => entry.entryResolution === 'skip').length
    + plan.findingEntries.filter((entry) => entry.entryResolution === 'skip').length;
  return {
    totalArtifacts: plan.artifactEntries.length,
    conflictingArtifacts: conflictingArtifacts.length,
    unresolvedArtifactConflicts,
    totalFindings: plan.findingEntries.length,
    conflictingFindings: fieldConflictFindings.length,
    unresolvedFindingConflicts,
    referenceConflicts: referenceConflicts.length,
    unresolvedReferenceConflicts,
    orphans: orphans.length,
    unresolvedOrphans,
    newArtifacts: plan.artifactEntries.filter((entry) => entry.kind === 'new').length,
    newFindings: plan.findingEntries.filter((entry) => entry.kind === 'new').length,
    skipped,
    identical: plan.artifactEntries.filter((entry) => entry.kind === 'identical').length
      + plan.findingEntries.filter((entry) => entry.kind === 'identical').length,
    ready: unresolvedArtifactConflicts === 0
      && unresolvedFindingConflicts === 0
      && unresolvedReferenceConflicts === 0
      && unresolvedOrphans === 0,
  };
}

/* ------------------------------------------------------------------ */
/* Apply: produce the next workspace state atomically                  */
/* ------------------------------------------------------------------ */

/**
 * Apply a fully-resolved merge plan. Throws if any conflict is unresolved so
 * callers can never commit "half a merge". Identity matching is by normalized
 * accession id, so re-running the same input against the result is a no-op.
 */
export function applyMergePlan(
  state: WorkspaceState,
  plan: MergePlan,
  at: string = new Date().toISOString(),
): WorkspaceState {
  const status = getMergePlanStatus(plan);
  if (!status.ready) {
    const unresolved = status.unresolvedArtifactConflicts
      + status.unresolvedFindingConflicts
      + status.unresolvedReferenceConflicts
      + status.unresolvedOrphans;
    throw new Error(
      `Cannot commit the merge: ${unresolved} record${unresolved === 1 ? ' still needs' : 's still need'} a decision.`,
    );
  }

  const nextArtifacts: Artifact[] = [];
  const upsertedByAccession = new Map<string, Artifact>();
  const skippedArtifactKeys = new Set(
    plan.artifactEntries.filter((entry) => entry.entryResolution === 'skip').map((entry) => entry.key),
  );

  for (const entry of plan.artifactEntries) {
    if (skippedArtifactKeys.has(entry.key)) continue;
    if (entry.kind === 'identical' || entry.kind === 'conflict') {
      const resolved = entry.kind === 'identical' ? entry.current! : entry.merged!;
      upsertedByAccession.set(normalizeAccessionId(entry.accessionId), resolved);
    } else if (entry.kind === 'new' && entry.merged && entry.entryResolution !== 'skip') {
      upsertedByAccession.set(normalizeAccessionId(entry.accessionId), entry.merged);
    }
  }

  // Preserve every existing object, replacing only records present in the plan.
  const touchedAccessions = new Set(upsertedByAccession.keys());
  for (const artifact of state.artifacts) {
    const accession = normalizeAccessionId(artifact.accessionId);
    nextArtifacts.push(touchedAccessions.has(accession) ? upsertedByAccession.get(accession)! : artifact);
  }
  for (const [accession, artifact] of upsertedByAccession) {
    if (!state.artifacts.some((existing) => normalizeAccessionId(existing.accessionId) === accession)) {
      nextArtifacts.push(artifact);
    }
  }

  // Resolve incoming finding links against stable identities.
  const artifactByAccession = new Map(
    nextArtifacts.map((artifact) => [normalizeAccessionId(artifact.accessionId), artifact]),
  );
  const zoneByLabel = new Map(state.zones.map((zone) => [zone.shortLabel.toLowerCase(), zone]));
  const skippedArtifactAccessions = new Set(
    plan.artifactEntries
      .filter((entry) => entry.entryResolution === 'skip')
      .map((entry) => normalizeAccessionId(entry.accessionId)),
  );

  const nextIssues: ReviewIssue[] = [];
  const replacedIssueIds = new Set<string>();

  const safeTargets = (entry: FindingMergeEntry): FindingMergeEntry =>
    entry.targetAccessionId && skippedArtifactAccessions.has(entry.targetAccessionId)
      ? { ...entry, targetAccessionId: undefined }
      : entry;

  for (const entry of plan.findingEntries) {
    if (entry.kind === 'identical') {
      continue; // existing record already correct
    }
    const resolution = entry.entryResolution ?? 'import';
    if (entry.kind === 'field-conflict' && entry.merged) {
      replacedIssueIds.add(entry.current!.id);
      nextIssues.push(linkFinding(entry.merged, safeTargets(entry), artifactByAccession, zoneByLabel, at));
    } else if (entry.kind === 'new' && entry.merged && resolution !== 'skip') {
      nextIssues.push(linkFinding({ ...entry.merged, id: entry.incomingNormalized!.id }, safeTargets(entry), artifactByAccession, zoneByLabel, at));
    } else if (entry.kind === 'reference-conflict' && entry.incomingNormalized && resolution !== 'skip') {
      // A dangling reference is either dropped on import or dropped together
      // with the record; it is never written as a broken link.
      const safeEntry: FindingMergeEntry = resolution === 'drop-link'
        ? { ...entry, targetAccessionId: undefined, targetZoneLabel: undefined }
        : entry;
      nextIssues.push(linkFinding(entry.incomingNormalized, safeEntry, artifactByAccession, zoneByLabel, at));
    }
  }

  for (const issue of state.issues) {
    if (!replacedIssueIds.has(issue.id)) nextIssues.push(issue);
  }

  // Reference integrity sweep: placements and surviving finding links must
  // resolve; untouched workspace data is carried through verbatim.
  const nextArtifactIds = new Set(nextArtifacts.map((artifact) => artifact.id));
  const nextZoneIds = new Set(state.zones.map((zone) => zone.id));
  const zones = state.zones.map((zone) => ({
    ...zone,
    artifactIds: zone.artifactIds.filter((id) => nextArtifactIds.has(id)),
  }));
  const issues = nextIssues.map((issue) => ({
    ...issue,
    artifactId: issue.artifactId && nextArtifactIds.has(issue.artifactId) ? issue.artifactId : undefined,
    zoneId: issue.zoneId && nextZoneIds.has(issue.zoneId) ? issue.zoneId : undefined,
  }));

  return {
    ...state,
    artifacts: nextArtifacts,
    zones,
    issues,
    lastSavedAt: at,
  };
}

function linkFinding(
  finding: ReviewIssue,
  entry: FindingMergeEntry,
  artifactByAccession: Map<string, Artifact>,
  zoneByLabel: Map<string, Zone>,
  at: string,
): ReviewIssue {
  const linked: ReviewIssue = { ...finding, updatedAt: at };
  if (entry.targetAccessionId) {
    const artifact = artifactByAccession.get(entry.targetAccessionId);
    if (artifact) linked.artifactId = artifact.id;
  }
  if (entry.targetZoneLabel) {
    const zone = zoneByLabel.get(entry.targetZoneLabel.toLowerCase());
    if (zone) linked.zoneId = zone.id;
  }
  return linked;
}

/* ------------------------------------------------------------------ */
/* Payload parsing                                                     */
/* ------------------------------------------------------------------ */

/**
 * Accept either the merge payload shape or a full exported workspace/snapshot
 * JSON (which embeds artifacts inside zones). Unknown shapes yield null.
 */
export function parseMergePayload(raw: string): { payload: MergeImportPayload; warnings: string[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'The file is not valid JSON.' };
  }
  if (!parsed || typeof parsed !== 'object') return { error: 'The file does not contain a workspace.' };
  const value = parsed as Record<string, unknown>;
  const warnings: string[] = [];

  if (Array.isArray(value.artifacts)) {
    const payload: MergeImportPayload = {
      artifacts: value.artifacts as IncomingArtifact[],
      findings: Array.isArray(value.findings) ? value.findings as IncomingFinding[] : undefined,
    };
    return { payload, warnings };
  }

  // Snapshot shape: { schemaVersion, zones: [{ artifacts }], unresolvedIssues }
  if (Array.isArray(value.zones)) {
    const artifacts: IncomingArtifact[] = [];
    const findings: IncomingFinding[] = [];
    const artifactIdToAccession = new Map<string, string>();
    const zoneIdToLabel = new Map<string, string>();
    for (const zone of value.zones as Array<Record<string, unknown>>) {
      if (typeof zone.id === 'string' && typeof zone.shortLabel === 'string') {
        zoneIdToLabel.set(zone.id, zone.shortLabel);
      }
      for (const artifact of (Array.isArray(zone.artifacts) ? zone.artifacts : []) as Array<IncomingArtifact & { id?: unknown }>) {
        artifacts.push(artifact);
        if (typeof artifact.id === 'string' && typeof artifact.accessionId === 'string') {
          artifactIdToAccession.set(artifact.id, artifact.accessionId);
        }
      }
    }
    for (const issue of (Array.isArray(value.unresolvedIssues) ? value.unresolvedIssues : []) as Array<Record<string, unknown>>) {
      const artifactRefId = typeof issue.artifactId === 'string' ? issue.artifactId : undefined;
      const zoneRefId = typeof issue.zoneId === 'string' ? issue.zoneId : undefined;
      findings.push({
        ...(issue as unknown as IncomingFinding),
        artifactAccessionId: artifactRefId ? artifactIdToAccession.get(artifactRefId) : undefined,
        zoneShortLabel: zoneRefId ? zoneIdToLabel.get(zoneRefId) : undefined,
      });
    }
    if (artifacts.length === 0) return { error: 'The snapshot contains no objects to reconcile.' };
    return { payload: { artifacts, findings }, warnings };
  }

  return { error: 'No artifact list was found in this file.' };
}
