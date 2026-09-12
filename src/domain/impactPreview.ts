import { needLabel } from './accessibility';
import { titleCase } from './formatters';
import { analyzeJourney } from './journeyAnalysis';
import type { Artifact, ConstraintFinding, ReadinessResult, WorkspaceState } from './models';
import { evaluateReadiness } from './reviewRules';

export interface FieldChange {
  key: 'isKeyObject' | 'narrativeRole' | 'dwellMinutes' | 'sensitivity' | 'accessibilityNeed';
  label: string;
  before: string;
  after: string;
}

export interface FindingDelta {
  kind: 'added' | 'resolved';
  finding: ConstraintFinding;
}

export interface ZoneImpact {
  zoneId: string;
  zoneName: string;
  capacityMinutes: number;
  dwellBefore: number;
  dwellAfter: number;
  utilizationBefore: number;
  utilizationAfter: number;
  addedFindings: ConstraintFinding[];
  resolvedFindings: ConstraintFinding[];
}

export interface ImpactPreview {
  artifactId: string;
  baseVersion: string;
  fieldChanges: FieldChange[];
  affectedZones: ZoneImpact[];
  journeyFindings: FindingDelta[];
  readinessBefore: ReadinessResult;
  readinessAfter: ReadinessResult;
  addedBlockers: ConstraintFinding[];
  hasImpact: boolean;
}

const CONSTRAINT_FIELDS: Array<{ key: FieldChange['key']; label: string; format: (artifact: Artifact) => string }> = [
  { key: 'isKeyObject', label: 'Key object', format: (artifact) => (artifact.isKeyObject ? 'Required' : 'Not required') },
  { key: 'narrativeRole', label: 'Narrative role', format: (artifact) => titleCase(artifact.narrativeRole) },
  { key: 'dwellMinutes', label: 'Dwell time', format: (artifact) => `${artifact.dwellMinutes} min` },
  { key: 'sensitivity', label: 'Sensitivity', format: (artifact) => titleCase(artifact.sensitivity) },
  { key: 'accessibilityNeed', label: 'Accessibility need', format: (artifact) => needLabel(artifact.accessibilityNeed) },
];

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(',')}}`;
}

function fingerprint(value: unknown): string {
  const input = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Version of every record an impact preview depends on. If this changes
 * between preview and confirm, the preview is stale and must be recomputed.
 */
export function impactBaseVersion(state: WorkspaceState): string {
  return fingerprint({
    project: state.project,
    artifacts: state.artifacts,
    zones: state.zones,
    issues: state.issues,
  });
}

function diffConstraintFields(before: Artifact, after: Artifact): FieldChange[] {
  return CONSTRAINT_FIELDS
    .filter(({ key }) => before[key] !== after[key])
    .map(({ key, label, format }) => ({ key, label, before: format(before), after: format(after) }));
}

/**
 * Pure what-if analysis: applies the candidate artifact to a copy of the
 * workspace and diffs journey constraints, findings, and readiness. The
 * saved plan is never mutated.
 */
export function previewArtifactImpact(state: WorkspaceState, next: Artifact, at = new Date()): ImpactPreview {
  const existing = state.artifacts.find((artifact) => artifact.id === next.id);
  const nextArtifacts = existing
    ? state.artifacts.map((artifact) => (artifact.id === next.id ? next : artifact))
    : [...state.artifacts, next];

  const before = analyzeJourney(state.artifacts, state.zones);
  const after = analyzeJourney(nextArtifacts, state.zones);
  const readinessBefore = evaluateReadiness(state, before, at);
  const readinessAfter = evaluateReadiness({ ...state, artifacts: nextArtifacts }, after, at);

  const beforeFindingIds = new Set(before.findings.map((finding) => finding.id));
  const afterFindingIds = new Set(after.findings.map((finding) => finding.id));
  const added = after.findings.filter((finding) => !beforeFindingIds.has(finding.id));
  const resolved = before.findings.filter((finding) => !afterFindingIds.has(finding.id));

  const affectedZones: ZoneImpact[] = [];
  for (const zone of state.zones) {
    const zoneBefore = before.zones.find((analysis) => analysis.zoneId === zone.id);
    const zoneAfter = after.zones.find((analysis) => analysis.zoneId === zone.id);
    if (!zoneBefore || !zoneAfter) continue;
    const addedFindings = added.filter((finding) => finding.zoneId === zone.id);
    const resolvedFindings = resolved.filter((finding) => finding.zoneId === zone.id);
    if (zoneBefore.dwellMinutes === zoneAfter.dwellMinutes && addedFindings.length === 0 && resolvedFindings.length === 0) continue;
    affectedZones.push({
      zoneId: zone.id,
      zoneName: zone.name,
      capacityMinutes: zone.capacityMinutes,
      dwellBefore: zoneBefore.dwellMinutes,
      dwellAfter: zoneAfter.dwellMinutes,
      utilizationBefore: zoneBefore.utilization,
      utilizationAfter: zoneAfter.utilization,
      addedFindings,
      resolvedFindings,
    });
  }

  const journeyFindings: FindingDelta[] = [
    ...added.filter((finding) => !finding.zoneId).map((finding): FindingDelta => ({ kind: 'added', finding })),
    ...resolved.filter((finding) => !finding.zoneId).map((finding): FindingDelta => ({ kind: 'resolved', finding })),
  ];

  const fieldChanges = existing ? diffConstraintFields(existing, next) : [];
  const addedBlockers = added.filter((finding) => finding.type === 'error');
  const hasImpact = fieldChanges.length > 0
    || affectedZones.length > 0
    || journeyFindings.length > 0
    || readinessBefore.ready !== readinessAfter.ready
    || readinessBefore.score !== readinessAfter.score;

  return {
    artifactId: next.id,
    baseVersion: impactBaseVersion(state),
    fieldChanges,
    affectedZones,
    journeyFindings,
    readinessBefore,
    readinessAfter,
    addedBlockers,
    hasImpact,
  };
}

/** One-line, human-readable summary of a confirmed change for the command log. */
export function summarizeImpact(preview: ImpactPreview): string {
  const segments = preview.fieldChanges.map((change) => `${change.label} ${change.before} → ${change.after}`);
  const addedCount = preview.affectedZones.reduce((count, zone) => count + zone.addedFindings.length, 0)
    + preview.journeyFindings.filter((delta) => delta.kind === 'added').length;
  const resolvedCount = preview.affectedZones.reduce((count, zone) => count + zone.resolvedFindings.length, 0)
    + preview.journeyFindings.filter((delta) => delta.kind === 'resolved').length;
  if (addedCount) segments.push(`${addedCount} finding${addedCount === 1 ? '' : 's'} added`);
  if (resolvedCount) segments.push(`${resolvedCount} finding${resolvedCount === 1 ? '' : 's'} resolved`);
  if (preview.addedBlockers.length) segments.push(`${preview.addedBlockers.length} new blocking finding${preview.addedBlockers.length === 1 ? '' : 's'}`);
  if (preview.readinessBefore.score !== preview.readinessAfter.score) {
    segments.push(`readiness ${preview.readinessBefore.score} → ${preview.readinessAfter.score}`);
  }
  return segments.length ? segments.join('; ') : 'No journey impact';
}
