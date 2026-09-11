import type { Artifact, PlanningPreferences, ReviewIssue, WorkspaceState, Zone } from '../domain/models';
import { normalizeAccessionId } from '../domain/ids';
import { workspaceReducer } from './reducer';
import type { WorkspaceAction } from './actions';

export type ChangeEntity = 'object' | 'placement' | 'finding' | 'preferences';
export type ChangeKind = 'added' | 'edited' | 'removed' | 'moved';

export interface ChangeItem {
  /** Stable key used to detect overlapping work, e.g. `object:artifact-1`. */
  key: string;
  entity: ChangeEntity;
  kind: ChangeKind;
  title: string;
  detail: string;
  fields: string[];
}

export interface ChangeReview {
  local: ChangeItem[];
  remote: ChangeItem[];
  /** True when the two sides touched the same record (or one removed what the other used). */
  overlap: boolean;
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

function zoneName(zones: Zone[], zoneId: string): string {
  return zones.find((zone) => zone.id === zoneId)?.name ?? 'another zone';
}

/* ---------------------------------- objects --------------------------------- */

const ARTIFACT_FIELDS: Array<{ key: keyof Artifact; label: string }> = [
  { key: 'accessionId', label: 'Accession ID' },
  { key: 'title', label: 'Title' },
  { key: 'maker', label: 'Maker' },
  { key: 'yearLabel', label: 'Date / period' },
  { key: 'medium', label: 'Medium' },
  { key: 'origin', label: 'Origin' },
  { key: 'summary', label: 'Summary' },
  { key: 'dwellMinutes', label: 'Dwell time' },
  { key: 'narrativeRole', label: 'Narrative role' },
  { key: 'sensitivity', label: 'Sensitivity' },
  { key: 'accessibilityNeed', label: 'Accessibility need' },
  { key: 'isKeyObject', label: 'Key object flag' },
  { key: 'tags', label: 'Tags' },
];

function artifactFieldChanges(before: Artifact, after: Artifact): string[] {
  const changed: string[] = [];
  for (const { key, label } of ARTIFACT_FIELDS) {
    if (key === 'tags') {
      const left = before.tags.join('|');
      const right = after.tags.join('|');
      if (left !== right) changed.push(label);
    } else if (before[key] !== after[key]) {
      changed.push(label);
    }
  }
  const dimensionsChanged = ['width', 'height', 'depth'].some(
    (axis) => before.dimensions[axis as 'width'] !== after.dimensions[axis as 'width'],
  );
  if (dimensionsChanged) changed.push('Dimensions');
  return changed;
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

function diffPlacements(base: WorkspaceState, next: WorkspaceState): ChangeItem[] {
  const changes: ChangeItem[] = [];
  const before = placementIndex(base.zones);
  const after = placementIndex(next.zones);
  const titles = new Map([...base.artifacts, ...next.artifacts].map((artifact) => [artifact.id, artifact]));

  for (const [artifactId, target] of after) {
    const source = before.get(artifactId);
    const title = titles.get(artifactId)?.title ?? artifactId;
    if (!source) {
      changes.push({ key: `placement:${artifactId}`, entity: 'placement', kind: 'added', title, detail: `Placed in ${zoneName(next.zones, target.zoneId)}`, fields: [] });
    } else if (source.zoneId !== target.zoneId || source.index !== target.index) {
      const detail = source.zoneId !== target.zoneId
        ? `Moved from ${zoneName(base.zones, source.zoneId)} to ${zoneName(next.zones, target.zoneId)}`
        : `Reordered within ${zoneName(next.zones, target.zoneId)}`;
      changes.push({ key: `placement:${artifactId}`, entity: 'placement', kind: 'moved', title, detail, fields: [] });
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

const ISSUE_FIELDS: Array<{ key: keyof ReviewIssue; label: string }> = [
  { key: 'title', label: 'Title' },
  { key: 'description', label: 'Description' },
  { key: 'severity', label: 'Severity' },
  { key: 'status', label: 'Status' },
  { key: 'owner', label: 'Owner' },
  { key: 'zoneId', label: 'Zone link' },
  { key: 'artifactId', label: 'Object link' },
];

function diffIssues(base: WorkspaceState, next: WorkspaceState): ChangeItem[] {
  const changes: ChangeItem[] = [];
  const baseById = new Map(base.issues.map((issue) => [issue.id, issue]));
  const nextById = new Map(next.issues.map((issue) => [issue.id, issue]));

  for (const issue of next.issues) {
    const before = baseById.get(issue.id);
    if (!before) {
      changes.push({ key: `issue:${issue.id}`, entity: 'finding', kind: 'added', title: issue.title, detail: `${issue.severity} finding`, fields: [] });
      continue;
    }
    const fields = ISSUE_FIELDS.filter(({ key }) => before[key] !== issue[key]).map(({ label }) => label);
    if (fields.length) {
      changes.push({ key: `issue:${issue.id}`, entity: 'finding', kind: 'edited', title: issue.title, detail: `Now ${issue.status}`, fields });
    }
  }
  for (const issue of base.issues) {
    if (!nextById.has(issue.id)) {
      changes.push({ key: `issue:${issue.id}`, entity: 'finding', kind: 'removed', title: issue.title, detail: `${issue.severity} finding`, fields: [] });
    }
  }
  return changes;
}

/* -------------------------------- preferences -------------------------------- */

const PREFERENCE_FIELDS: Array<{ key: keyof PlanningPreferences; label: string }> = [
  { key: 'pace', label: 'Visit pace' },
  { key: 'accessibilityPriority', label: 'Accessibility priority' },
  { key: 'groupSize', label: 'Group size' },
];

function diffPreferences(base: WorkspaceState, next: WorkspaceState): ChangeItem[] {
  const fields = PREFERENCE_FIELDS.filter(({ key }) => base.preferences[key] !== next.preferences[key]).map(({ label }) => label);
  if (!fields.length) return [];
  return [{
    key: 'preferences',
    entity: 'preferences',
    kind: 'edited',
    title: 'Planning preferences',
    detail: `${next.preferences.pace} pace · ${next.preferences.groupSize} people`,
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

function hasOverlap(local: ChangeItem[], remote: ChangeItem[]): boolean {
  const remoteKeys = new Set(remote.map((change) => change.key));
  if (local.some((change) => remoteKeys.has(change.key))) return true;

  const remoteRemovedArtifacts = new Set(
    remote.filter((change) => change.entity === 'object' && change.kind === 'removed').map((change) => change.key.slice('object:'.length)),
  );
  const localTouchedArtifacts = new Set(
    local
      .filter((change) => change.entity === 'object' || change.entity === 'placement')
      .map((change) => change.key.split(':')[1]),
  );
  for (const artifactId of remoteRemovedArtifacts) {
    if (localTouchedArtifacts.has(artifactId)) return true;
  }

  const localRemovedArtifacts = new Set(
    local.filter((change) => change.entity === 'object' && change.kind === 'removed').map((change) => change.key.slice('object:'.length)),
  );
  const remoteTouchedArtifacts = new Set(
    remote
      .filter((change) => change.entity === 'object' || change.entity === 'placement')
      .map((change) => change.key.split(':')[1]),
  );
  for (const artifactId of localRemovedArtifacts) {
    if (remoteTouchedArtifacts.has(artifactId)) return true;
  }
  return false;
}

/** Summarize the local pending change and the already-saved remote change. */
export function reviewChanges(base: WorkspaceState, local: WorkspaceState, remote: WorkspaceState): ChangeReview {
  const localChanges = diffWorkspace(base, local);
  const remoteChanges = diffWorkspace(base, remote);
  return { local: localChanges, remote: remoteChanges, overlap: hasOverlap(localChanges, remoteChanges) };
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
