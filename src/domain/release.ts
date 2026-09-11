import { analyzeJourney } from './journeyAnalysis';
import type {
  Artifact,
  PlanningPreferences,
  ReadinessResult,
  ReleaseChecklist,
  ReleaseFingerprints,
  ReleasePackage,
  ReleaseReadinessSummary,
  ReleaseZone,
  ReviewIssue,
  Snapshot,
  WorkspaceState,
  Zone,
} from './models';
import { buildZoneChecklist } from './zoneChecklist';

export const RELEASE_SCHEMA_VERSION = 1;

export function formatReleaseNumber(number: number): string {
  return `REL-${String(number).padStart(4, '0')}`;
}

export function nextReleaseNumber(state: Pick<WorkspaceState, 'releaseSequence'>): number {
  return state.releaseSequence + 1;
}

export function releaseFileName(release: Pick<ReleasePackage, 'number' | 'publishedAt'>, dateOverride?: Date): string {
  const date = (dateOverride ?? new Date(release.publishedAt)).toISOString().slice(0, 10);
  return `exhibit-flow-release-${String(release.number).padStart(4, '0')}-${date}.json`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

export function fingerprint(value: unknown): string {
  // FNV-1a over canonical JSON so key order never matters.
  const text = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function collectFingerprints(state: WorkspaceState): ReleaseFingerprints {
  const byKey = <T extends { id: string }>(items: T[]) =>
    Object.fromEntries([...items]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((item) => [item.id, fingerprint(item)]));
  // Sorting before keying makes the fingerprint table insensitive to the order in
  // which records happen to live in their workspace array; actual content changes
  // (including placement order inside a zone, which is part of the zone record) still hash differently.
  return {
    artifacts: byKey(state.artifacts),
    zones: byKey(state.zones),
    issues: byKey(state.issues),
  };
}

function buildReleaseReadiness(state: WorkspaceState, readiness: ReadinessResult): ReleaseReadinessSummary {
  const analysis = analyzeJourney(state.artifacts, state.zones);
  return {
    ready: readiness.ready,
    score: readiness.score,
    blockers: [...readiness.blockers],
    cautions: [...readiness.cautions],
    checkedAt: readiness.checkedAt,
    visitMinutes: analysis.totalDwellMinutes,
    placedCount: analysis.placedCount,
    unplacedCount: analysis.unplacedCount,
    artifactCount: state.artifacts.length,
    zoneCount: state.zones.length,
    unresolvedCriticalCount: state.issues.filter(
      (issue) => issue.severity === 'critical' && issue.status !== 'resolved',
    ).length,
  };
}

function freezeChecklist(state: WorkspaceState, zone: Zone, at: Date): ReleaseChecklist {
  const checklist = buildZoneChecklist(state, zone.id, at);
  if (!checklist) throw new Error(`Cannot freeze checklist for unknown zone ${zone.id}.`);
  return clone({
    zoneId: checklist.zoneId,
    zoneName: checklist.zoneName,
    zoneShortLabel: checklist.zoneShortLabel,
    thesis: checklist.thesis,
    generatedAt: checklist.generatedAt,
    totalDwellMinutes: checklist.totalDwellMinutes,
    objectCount: checklist.objectCount,
    unresolvedCount: checklist.unresolvedCount,
    zoneFindings: checklist.zoneFindings,
    entries: checklist.entries,
  });
}

function freezeZones(state: WorkspaceState, at: Date): ReleaseZone[] {
  const artifactById = new Map(state.artifacts.map((artifact) => [artifact.id, artifact]));
  return [...state.zones]
    .sort((left, right) => left.sequence - right.sequence)
    .map((zone) => {
      const frozenZone = clone(zone);
      return {
        zone: frozenZone,
        artifacts: zone.artifactIds
          .map((id) => artifactById.get(id))
          .filter((artifact): artifact is Artifact => Boolean(artifact))
          .map((artifact) => clone(artifact)),
        checklist: freezeChecklist(state, zone, at),
      };
    });
}

export function buildReleasePackage(
  state: WorkspaceState,
  readiness: ReadinessResult,
  at = new Date(),
  number = nextReleaseNumber(state),
): ReleasePackage {
  if (!readiness.ready) {
    throw new Error('A release package can only be published when the plan passes readiness checks.');
  }
  const publishedAt = at.toISOString();
  const readyProject: WorkspaceState['project'] = {
    ...state.project,
    stage: 'ready',
    lastReadinessCheck: readiness.checkedAt,
  };
  const frozen: WorkspaceState = {
    ...state,
    project: readyProject,
    artifacts: clone(state.artifacts),
    zones: clone(state.zones),
    issues: clone(state.issues),
    preferences: clone(state.preferences),
    releases: [],
    releaseSequence: state.releaseSequence,
  };
  const placedIds = new Set(frozen.zones.flatMap((zone) => zone.artifactIds));
  const zones = freezeZones(frozen, at);
  return {
    kind: 'review-release',
    schemaVersion: RELEASE_SCHEMA_VERSION,
    id: `release-${String(number).padStart(4, '0')}`,
    number,
    label: formatReleaseNumber(number),
    publishedAt,
    project: clone(readyProject),
    preferences: clone(frozen.preferences) as PlanningPreferences,
    zones,
    unplacedArtifacts: frozen.artifacts
      .filter((artifact) => !placedIds.has(artifact.id))
      .sort((left, right) => left.title.localeCompare(right.title))
      .map((artifact) => clone(artifact)),
    issues: [...frozen.issues]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((issue) => clone(issue)),
    readiness: buildReleaseReadiness(frozen, readiness),
    fingerprints: collectFingerprints(frozen),
  };
}

export function serializeReleasePackage(release: ReleasePackage): string {
  return JSON.stringify(release, null, 2);
}

export function isReleasePackage(value: unknown): value is ReleasePackage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ReleasePackage>;
  return candidate.kind === 'review-release'
    && candidate.schemaVersion === RELEASE_SCHEMA_VERSION
    && typeof candidate.number === 'number'
    && typeof candidate.label === 'string'
    && typeof candidate.publishedAt === 'string'
    && Boolean(candidate.project)
    && Array.isArray(candidate.zones)
    && Array.isArray(candidate.unplacedArtifacts)
    && Array.isArray(candidate.issues)
    && Boolean(candidate.readiness)
    && Boolean(candidate.fingerprints)
    && typeof candidate.fingerprints?.artifacts === 'object'
    && typeof candidate.fingerprints?.zones === 'object'
    && typeof candidate.fingerprints?.issues === 'object';
}

export function parseReleasePackage(raw: string): ReleasePackage | null {
  try {
    const value: unknown = JSON.parse(raw);
    return isReleasePackage(value) ? value : null;
  } catch {
    return null;
  }
}

export type DriftChange = 'changed' | 'removed' | 'added';
export type DriftRecordKind = 'artifact' | 'zone' | 'issue';

export interface DriftEntry {
  kind: DriftRecordKind;
  id: string;
  label: string;
  change: DriftChange;
  fieldChanges: string[];
}

export interface DriftReport {
  drifted: boolean;
  checkedAt: string;
  partial: boolean;
  entries: DriftEntry[];
  counts: Record<DriftRecordKind, number>;
}

interface DriftBaseline {
  artifacts: Map<string, Artifact>;
  zones: Map<string, Zone>;
  issues: Map<string, ReviewIssue>;
  fingerprints: ReleaseFingerprints;
  partial: boolean;
}

const ARTIFACT_DIFF_FIELDS: Array<[keyof Artifact, string]> = [
  ['title', 'title'],
  ['accessionId', 'accession ID'],
  ['maker', 'maker'],
  ['yearLabel', 'period'],
  ['medium', 'medium'],
  ['origin', 'origin'],
  ['summary', 'summary'],
  ['dimensions', 'dimensions'],
  ['dwellMinutes', 'dwell time'],
  ['narrativeRole', 'narrative role'],
  ['sensitivity', 'sensitivity'],
  ['accessibilityNeed', 'accessibility need'],
  ['isKeyObject', 'key-object flag'],
  ['tags', 'tags'],
];

const ZONE_DIFF_FIELDS: Array<[keyof Zone, string]> = [
  ['name', 'name'],
  ['shortLabel', 'short label'],
  ['thesis', 'thesis'],
  ['capacityMinutes', 'dwell capacity'],
  ['maxObjects', 'object limit'],
  ['lowLight', 'low-light setting'],
  ['hasSeating', 'seating'],
  ['sequence', 'sequence position'],
  ['color', 'color'],
  ['artifactIds', 'placed objects'],
];

const ISSUE_DIFF_FIELDS: Array<[keyof ReviewIssue, string]> = [
  ['title', 'title'],
  ['description', 'description'],
  ['severity', 'severity'],
  ['status', 'status'],
  ['owner', 'owner'],
  ['zoneId', 'zone link'],
  ['artifactId', 'object link'],
];

function fieldChanges<T extends { id: string }>(before: T, after: T, fields: Array<[keyof T, string]>): string[] {
  const changes: string[] = [];
  for (const [field, label] of fields) {
    if (stableStringify(before[field]) !== stableStringify(after[field])) changes.push(label);
  }
  return changes;
}

function artifactLabel(artifact: Artifact): string {
  return `${artifact.title} (${artifact.accessionId})`;
}

function compareEntries(left: DriftEntry, right: DriftEntry): number {
  const kindOrder: Record<DriftRecordKind, number> = { artifact: 0, zone: 1, issue: 2 };
  if (kindOrder[left.kind] !== kindOrder[right.kind]) return kindOrder[left.kind] - kindOrder[right.kind];
  const changeOrder: Record<DriftChange, number> = { removed: 0, changed: 1, added: 2 };
  if (changeOrder[left.change] !== changeOrder[right.change]) return changeOrder[left.change] - changeOrder[right.change];
  return left.label.localeCompare(right.label);
}

function assessDrift(baseline: DriftBaseline, state: WorkspaceState, at: Date): DriftReport {
  const entries: DriftEntry[] = [];

  for (const [id, before] of baseline.artifacts) {
    const current = state.artifacts.find((artifact) => artifact.id === id);
    if (!current) {
      entries.push({ kind: 'artifact', id, label: artifactLabel(before), change: 'removed', fieldChanges: [] });
    } else if (fingerprint(current) !== baseline.fingerprints.artifacts[id]) {
      entries.push({ kind: 'artifact', id, label: artifactLabel(before), change: 'changed', fieldChanges: fieldChanges(before, current, ARTIFACT_DIFF_FIELDS) });
    }
  }
  for (const artifact of state.artifacts) {
    if (!baseline.partial && !baseline.artifacts.has(artifact.id)) {
      entries.push({ kind: 'artifact', id: artifact.id, label: artifactLabel(artifact), change: 'added', fieldChanges: [] });
    }
  }

  for (const [id, before] of baseline.zones) {
    const current = state.zones.find((zone) => zone.id === id);
    if (!current) {
      entries.push({ kind: 'zone', id, label: before.name, change: 'removed', fieldChanges: [] });
    } else if (fingerprint(current) !== baseline.fingerprints.zones[id]) {
      entries.push({ kind: 'zone', id, label: before.name, change: 'changed', fieldChanges: fieldChanges(before, current, ZONE_DIFF_FIELDS) });
    }
  }
  for (const zone of state.zones) {
    if (!baseline.partial && !baseline.zones.has(zone.id)) entries.push({ kind: 'zone', id: zone.id, label: zone.name, change: 'added', fieldChanges: [] });
  }

  for (const [id, before] of baseline.issues) {
    const current = state.issues.find((issue) => issue.id === id);
    if (!current) {
      entries.push({ kind: 'issue', id, label: before.title, change: 'removed', fieldChanges: [] });
    } else if (fingerprint(current) !== baseline.fingerprints.issues[id]) {
      entries.push({ kind: 'issue', id, label: before.title, change: 'changed', fieldChanges: fieldChanges(before, current, ISSUE_DIFF_FIELDS) });
    }
  }
  for (const issue of state.issues) {
    if (!baseline.partial && !baseline.issues.has(issue.id)) entries.push({ kind: 'issue', id: issue.id, label: issue.title, change: 'added', fieldChanges: [] });
  }

  entries.sort(compareEntries);
  const counts: Record<DriftRecordKind, number> = {
    artifact: entries.filter((entry) => entry.kind === 'artifact').length,
    zone: entries.filter((entry) => entry.kind === 'zone').length,
    issue: entries.filter((entry) => entry.kind === 'issue').length,
  };
  return { drifted: entries.length > 0, checkedAt: at.toISOString(), partial: baseline.partial, entries, counts };
}

function baselineFromRelease(release: ReleasePackage): DriftBaseline {
  const artifacts = new Map<string, Artifact>();
  const zones = new Map<string, Zone>();
  for (const releaseZone of release.zones) {
    zones.set(releaseZone.zone.id, releaseZone.zone);
    for (const artifact of releaseZone.artifacts) artifacts.set(artifact.id, artifact);
  }
  for (const artifact of release.unplacedArtifacts) artifacts.set(artifact.id, artifact);
  const issues = new Map(release.issues.map((issue) => [issue.id, issue]));
  return { artifacts, zones, issues, fingerprints: release.fingerprints, partial: false };
}

export function assessReleaseDrift(release: ReleasePackage, state: WorkspaceState, at = new Date()): DriftReport {
  return assessDrift(baselineFromRelease(release), state, at);
}

export function assessSnapshotDrift(snapshot: Snapshot, state: WorkspaceState, at = new Date()): DriftReport {
  const artifacts = new Map<string, Artifact>();
  const zones = new Map<string, Zone>();
  for (const zone of snapshot.zones) {
    const { artifacts: zoneArtifacts, ...zoneFields } = zone;
    zones.set(zoneFields.id, zoneFields as Zone);
    for (const artifact of zoneArtifacts) artifacts.set(artifact.id, artifact);
  }
  const issues = new Map(snapshot.unresolvedIssues.map((issue) => [issue.id, issue]));
  const fingerprints: ReleaseFingerprints = {
    artifacts: Object.fromEntries([...artifacts.values()].map((artifact) => [artifact.id, fingerprint(artifact)])),
    zones: Object.fromEntries([...zones.values()].map((zone) => [zone.id, fingerprint(zone)])),
    issues: Object.fromEntries([...issues.values()].map((issue) => [issue.id, fingerprint(issue)])),
  };
  return assessDrift({ artifacts, zones, issues, fingerprints, partial: true }, state, at);
}
