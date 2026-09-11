import type { Artifact, PlanningPreferences, ReviewIssue, WorkspaceState, Zone } from '../domain/models';
import { normalizeAccessionId } from '../domain/ids';
import { titleCase } from '../domain/formatters';
import { workspaceReducer } from './reducer';
import type { WorkspaceAction } from './actions';

export type ChangeEntity = 'object' | 'placement' | 'finding' | 'preferences';
export type ChangeKind = 'added' | 'edited' | 'removed' | 'moved';

/** One field on one side of a change: the base value and that side's new value. */
export interface FieldDiff {
  label: string;
  before: string;
  after: string;
}

export interface ChangeItem {
  /** Stable key used to detect overlapping work, e.g. `object:artifact-1`. */
  key: string;
  entity: ChangeEntity;
  kind: ChangeKind;
  title: string;
  detail: string;
  fields: FieldDiff[];
}

/** Same record touched on both sides, with every competing value side by side. */
export interface OverlapRecord {
  key: string;
  entity: ChangeEntity;
  title: string;
  localKind: ChangeKind;
  remoteKind: ChangeKind;
  rows: Array<{ label: string; base: string; local: string; remote: string }>;
}

export interface ChangeReview {
  local: ChangeItem[];
  remote: ChangeItem[];
  /** True when the two sides touched the same record (or one removed what the other used). */
  overlap: boolean;
  /** Record-level comparisons carrying the original value and both new values. */
  overlapping: OverlapRecord[];
}

const MISSING = '—';
const UNPLACED = 'Unplaced';

function textOrDash(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  return trimmed || MISSING;
}

type PlacementIndex = Map<string, { zoneId: string; index: number }>;

function placementIndex(zones: Zone[]): PlacementIndex {
  const index: PlacementIndex = new Map();
  for (const zone of zones) {
    zone.artifactIds.forEach((artifactId, position) => {
      index.set(artifactId, { zoneId: zone.id, index: position });
    });
  }
  return index;
}

function zoneName(zones: Zone[], zoneId: string | undefined): string {
  if (!zoneId) return MISSING;
  return zones.find((zone) => zone.id === zoneId)?.name ?? zoneId;
}

/* ---------------------------------- objects --------------------------------- */

const ARTIFACT_FIELD_SPECS: Array<{ label: string; get: (artifact: Artifact) => string }> = [
  { label: 'Accession ID', get: (artifact) => textOrDash(artifact.accessionId) },
  { label: 'Title', get: (artifact) => textOrDash(artifact.title) },
  { label: 'Maker', get: (artifact) => textOrDash(artifact.maker) },
  { label: 'Date / period', get: (artifact) => textOrDash(artifact.yearLabel) },
  { label: 'Medium', get: (artifact) => textOrDash(artifact.medium) },
  { label: 'Origin', get: (artifact) => textOrDash(artifact.origin) },
  { label: 'Summary', get: (artifact) => textOrDash(artifact.summary) },
  { label: 'Dwell time', get: (artifact) => `${artifact.dwellMinutes} min` },
  { label: 'Narrative role', get: (artifact) => titleCase(artifact.narrativeRole) },
  { label: 'Sensitivity', get: (artifact) => titleCase(artifact.sensitivity) },
  { label: 'Accessibility need', get: (artifact) => titleCase(artifact.accessibilityNeed) },
  { label: 'Object status', get: (artifact) => (artifact.isKeyObject ? 'Key object' : 'Standard object') },
  { label: 'Tags', get: (artifact) => (artifact.tags.length ? artifact.tags.join(', ') : MISSING) },
  { label: 'Dimensions', get: (artifact) => `${artifact.dimensions.width} × ${artifact.dimensions.height} × ${artifact.dimensions.depth} cm` },
];

function artifactFieldChanges(before: Artifact, after: Artifact): FieldDiff[] {
  const changes: FieldDiff[] = [];
  for (const spec of ARTIFACT_FIELD_SPECS) {
    const oldValue = spec.get(before);
    const newValue = spec.get(after);
    if (oldValue !== newValue) changes.push({ label: spec.label, before: oldValue, after: newValue });
  }
  return changes;
}

function diffArtifacts(base: WorkspaceState, next: WorkspaceState): ChangeItem[] {
  const changes: ChangeItem[] = [];
  const baseById = new Map(base.artifacts.map((artifact) => [artifact.id, artifact]));
  const nextById = new Map(next.artifacts.map((artifact) => [artifact.id, artifact]));

  for (const artifact of next.artifacts) {
    const before = baseById.get(artifact.id);
    if (!before) {
      changes.push({ key: `object:${artifact.id}`, entity: 'object', kind: 'added', title: artifact.title, detail: artifact.accessionId, fields: [] });
    } else {
      const fields = artifactFieldChanges(before, artifact);
      if (fields.length) {
        changes.push({ key: `object:${artifact.id}`, entity: 'object', kind: 'edited', title: artifact.title, detail: artifact.accessionId, fields });
      }
    }
  }
  for (const artifact of base.artifacts) {
    if (!nextById.has(artifact.id)) {
      changes.push({ key: `object:${artifact.id}`, entity: 'object', kind: 'removed', title: artifact.title, detail: artifact.accessionId, fields: [] });
    }
  }
  return changes;
}

/* --------------------------------- placements -------------------------------- */

function placementFields(before: { zoneId: string; index: number } | undefined, after: { zoneId: string; index: number } | undefined, zones: Zone[]): FieldDiff[] {
  const fields: FieldDiff[] = [];
  const beforeZone = before ? zoneName(zones, before.zoneId) : UNPLACED;
  const afterZone = after ? zoneName(zones, after.zoneId) : UNPLACED;
  if (beforeZone !== afterZone) fields.push({ label: 'Zone', before: beforeZone, after: afterZone });
  const beforePosition = before ? `Position ${before.index + 1}` : MISSING;
  const afterPosition = after ? `Position ${after.index + 1}` : MISSING;
  if (beforePosition !== afterPosition) fields.push({ label: 'Sequence', before: beforePosition, after: afterPosition });
  return fields;
}

function diffPlacements(base: WorkspaceState, next: WorkspaceState): ChangeItem[] {
  const changes: ChangeItem[] = [];
  const before = placementIndex(base.zones);
  const after = placementIndex(next.zones);
  const titles = new Map([...base.artifacts, ...next.artifacts].map((artifact) => [artifact.id, artifact]));
  const zones = [...base.zones, ...next.zones];

  for (const [artifactId, target] of after) {
    const source = before.get(artifactId);
    const title = titles.get(artifactId)?.title ?? artifactId;
    const fields = placementFields(source, target, zones);
    if (!source) {
      changes.push({ key: `placement:${artifactId}`, entity: 'placement', kind: 'added', title, detail: `Placed in ${zoneName(next.zones, target.zoneId)}`, fields });
    } else if (source.zoneId !== target.zoneId || source.index !== target.index) {
      const detail = source.zoneId !== target.zoneId
        ? `Moved from ${zoneName(base.zones, source.zoneId)} to ${zoneName(next.zones, target.zoneId)}`
        : `Reordered within ${zoneName(next.zones, target.zoneId)}`;
      changes.push({ key: `placement:${artifactId}`, entity: 'placement', kind: 'moved', title, detail, fields });
    }
  }
  for (const [artifactId, source] of before) {
    if (!after.has(artifactId)) {
      const title = titles.get(artifactId)?.title ?? artifactId;
      changes.push({ key: `placement:${artifactId}`, entity: 'placement', kind: 'removed', title, detail: `Removed from ${zoneName(base.zones, source.zoneId)}`, fields: [] });
    }
  }
  return changes;
}

/* ---------------------------------- findings --------------------------------- */

function issueFieldSpecs(zones: Zone[], artifacts: Artifact[]): Array<{ label: string; get: (issue: ReviewIssue) => string }> {
  return [
    { label: 'Title', get: (issue) => textOrDash(issue.title) },
    { label: 'Description', get: (issue) => textOrDash(issue.description) },
    { label: 'Severity', get: (issue) => titleCase(issue.severity) },
    { label: 'Status', get: (issue) => titleCase(issue.status) },
    { label: 'Owner', get: (issue) => textOrDash(issue.owner) },
    { label: 'Zone link', get: (issue) => (issue.zoneId ? zoneName(zones, issue.zoneId) : MISSING) },
    { label: 'Object link', get: (issue) => artifacts.find((artifact) => artifact.id === issue.artifactId)?.title ?? MISSING },
  ];
}

function diffIssues(base: WorkspaceState, next: WorkspaceState): ChangeItem[] {
  const changes: ChangeItem[] = [];
  const baseById = new Map(base.issues.map((issue) => [issue.id, issue]));
  const nextById = new Map(next.issues.map((issue) => [issue.id, issue]));
  const zones = [...base.zones, ...next.zones];
  const artifacts = [...base.artifacts, ...next.artifacts];
  const specs = issueFieldSpecs(zones, artifacts);

  for (const issue of next.issues) {
    const before = baseById.get(issue.id);
    if (!before) {
      changes.push({ key: `issue:${issue.id}`, entity: 'finding', kind: 'added', title: issue.title, detail: `${titleCase(issue.severity)} finding`, fields: [] });
      continue;
    }
    const fields: FieldDiff[] = [];
    for (const spec of specs) {
      const oldValue = spec.get(before);
      const newValue = spec.get(issue);
      if (oldValue !== newValue) fields.push({ label: spec.label, before: oldValue, after: newValue });
    }
    if (fields.length) {
      changes.push({ key: `issue:${issue.id}`, entity: 'finding', kind: 'edited', title: issue.title, detail: `Now ${titleCase(issue.status)}`, fields });
    }
  }
  for (const issue of base.issues) {
    if (!nextById.has(issue.id)) {
      changes.push({ key: `issue:${issue.id}`, entity: 'finding', kind: 'removed', title: issue.title, detail: `${titleCase(issue.severity)} finding`, fields: [] });
    }
  }
  return changes;
}

/* -------------------------------- preferences -------------------------------- */

const PREFERENCE_SPECS: Array<{ label: string; get: (preferences: PlanningPreferences) => string }> = [
  { label: 'Visit pace', get: (preferences) => titleCase(preferences.pace) },
  { label: 'Accessibility priority', get: (preferences) => `${preferences.accessibilityPriority}%` },
  { label: 'Group size', get: (preferences) => `${preferences.groupSize} people` },
];

function diffPreferences(base: WorkspaceState, next: WorkspaceState): ChangeItem[] {
  const fields: FieldDiff[] = [];
  for (const spec of PREFERENCE_SPECS) {
    const oldValue = spec.get(base.preferences);
    const newValue = spec.get(next.preferences);
    if (oldValue !== newValue) fields.push({ label: spec.label, before: oldValue, after: newValue });
  }
  if (!fields.length) return [];
  return [{
    key: 'preferences',
    entity: 'preferences',
    kind: 'edited',
    title: 'Planning preferences',
    detail: `${titleCase(next.preferences.pace)} pace · ${next.preferences.groupSize} people`,
    fields,
  }];
}

function diffWorkspace(base: WorkspaceState, next: WorkspaceState): ChangeItem[] {
  return [
    ...diffArtifacts(base, next),
    ...diffPlacements(base, next),
    ...diffIssues(base, next),
    ...diffPreferences(base, next),
  ];
}

/* ---------------------------------- overlap --------------------------------- */

const KIND_PHRASE: Record<ChangeKind, string> = {
  added: 'added',
  edited: 'edited',
  removed: 'removed',
  moved: 'moved',
};

/** Pair local and remote items that touch the same record and line up every competing value. */
function collectOverlapping(local: ChangeItem[], remote: ChangeItem[]): OverlapRecord[] {
  const records: OverlapRecord[] = [];
  const remoteByKey = new Map(remote.map((item) => [item.key, item]));
  const consumedRemote = new Set<string>();

  const pushRecord = (localItem: ChangeItem, remoteItem: ChangeItem) => {
    consumedRemote.add(remoteItem.key);
    const rows = new Map<string, OverlapRecord['rows'][number]>();
    for (const field of localItem.fields) {
      rows.set(field.label, { label: field.label, base: field.before, local: field.after, remote: field.before });
    }
    for (const field of remoteItem.fields) {
      const existing = rows.get(field.label);
      if (existing) {
        existing.remote = field.after;
      } else {
        rows.set(field.label, { label: field.label, base: field.before, local: field.before, remote: field.after });
      }
    }
    records.push({
      key: localItem.key,
      entity: localItem.entity,
      title: localItem.title,
      localKind: localItem.kind,
      remoteKind: remoteItem.kind,
      rows: [...rows.values()],
    });
  };

  for (const localItem of local) {
    let partner = remoteByKey.get(localItem.key);

    // Removing an object while the other side places/edits it is also an overlap.
    if (!partner && localItem.entity === 'object' && localItem.kind === 'removed') {
      const artifactId = localItem.key.slice('object:'.length);
      partner = remote.find((item) => item.key === `object:${artifactId}` || item.key === `placement:${artifactId}`);
    }
    if (!partner && localItem.entity === 'placement') {
      const artifactId = localItem.key.slice('placement:'.length);
      partner = remote.find((item) => item.key === `object:${artifactId}` && item.kind === 'removed');
    }
    if (partner) pushRecord(localItem, partner);
  }

  // Object removed remotely while it was added/placed locally.
  for (const remoteItem of remote) {
    if (consumedRemote.has(remoteItem.key)) continue;
    if (remoteItem.entity !== 'object' || remoteItem.kind !== 'removed') continue;
    const artifactId = remoteItem.key.slice('object:'.length);
    const localItem = local.find((item) => item.key === `object:${artifactId}` || item.key === `placement:${artifactId}`);
    if (localItem) pushRecord(localItem, remoteItem);
  }

  return records;
}

export function overlapSummary(record: OverlapRecord): string | null {
  if (record.rows.length) return null;
  if (record.localKind === 'removed' || record.remoteKind === 'removed') {
    return `The record was ${KIND_PHRASE[record.localKind]} in your tab and ${KIND_PHRASE[record.remoteKind]} in the other tab.`;
  }
  return `The record was ${KIND_PHRASE[record.localKind]} in your tab and ${KIND_PHRASE[record.remoteKind]} in the other tab.`;
}

/** Summarize the local pending change and the already-saved remote change. */
export function reviewChanges(base: WorkspaceState, local: WorkspaceState, remote: WorkspaceState): ChangeReview {
  const localChanges = diffWorkspace(base, local);
  const remoteChanges = diffWorkspace(base, remote);
  const overlapping = collectOverlapping(localChanges, remoteChanges);
  return { local: localChanges, remote: remoteChanges, overlap: overlapping.length > 0, overlapping };
}

/* ---------------------------------- replay ---------------------------------- */

export interface ReplayResult {
  state: WorkspaceState;
  errors: string[];
}

/**
 * Re-express the intents captured in the stale tab on top of the newest saved
 * workspace. Placement intents are translated against the stale tab's layout
 * so "put it third in this zone" keeps its intended position. Reducer errors
 * (illegal transitions, missing records) are collected, never thrown.
 */
export function replayIntents(intents: WorkspaceAction[], local: WorkspaceState, remote: WorkspaceState): ReplayResult {
  const errors: string[] = [];
  let state = remote;
  const localPlacements = placementIndex(local.zones);

  for (const intent of intents) {
    let action = intent;
    if (intent.type === 'placement/assign' || intent.type === 'placement/reorder') {
      const target = localPlacements.get(intent.artifactId);
      if (!target) {
        errors.push(`Placement for ${intent.artifactId} could not be repeated because the object is unplaced in your tab.`);
        continue;
      }
      action = { type: 'placement/assign', artifactId: intent.artifactId, zoneId: target.zoneId, index: target.index };
    }
    try {
      state = workspaceReducer(state, action);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'A change could not be repeated.');
    }
  }

  errors.push(...validateReplayedState(state));
  return { state, errors };
}

/** Sanity checks for a state produced by replaying changes onto newer data. */
function validateReplayedState(state: WorkspaceState): string[] {
  const errors: string[] = [];

  const accessions = new Map<string, string>();
  for (const artifact of state.artifacts) {
    const normalized = normalizeAccessionId(artifact.accessionId);
    const existing = accessions.get(normalized);
    if (existing) errors.push(`Accession ID ${normalized} is now used by more than one object.`);
    else accessions.set(normalized, artifact.id);
  }

  const artifactIds = new Set(state.artifacts.map((artifact) => artifact.id));
  const zoneIds = new Set(state.zones.map((zone) => zone.id));
  for (const zone of state.zones) {
    const seen = new Set<string>();
    for (const artifactId of zone.artifactIds) {
      if (!artifactIds.has(artifactId)) {
        errors.push(`A placement in ${zone.name} points to an object that no longer exists.`);
        break;
      }
      if (seen.has(artifactId)) {
        errors.push(`An object is placed more than once in ${zone.name}.`);
        break;
      }
      seen.add(artifactId);
    }
  }
  for (const issue of state.issues) {
    if (issue.zoneId && !zoneIds.has(issue.zoneId)) errors.push(`Finding “${issue.title}” links to a zone that no longer exists.`);
    if (issue.artifactId && !artifactIds.has(issue.artifactId)) errors.push(`Finding “${issue.title}” links to an object that no longer exists.`);
  }
  return errors;
}
