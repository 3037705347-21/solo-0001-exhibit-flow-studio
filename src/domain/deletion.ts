import { createId, normalizeAccessionId } from './ids';
import type {
  Artifact,
  DeletionRecord,
  DeletionTargetKind,
  PublishedPackage,
  RestoreConflict,
  RestoreDecision,
  RestoreReport,
  RestoreSummaryLine,
  ReviewIssue,
  WorkspaceState,
  Zone,
} from './models';

/** A deletion can be undone through the recovery center for this long. */
export const RESTORE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** After this audit horizon the deletion record itself is pruned. */
export const AUDIT_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

export interface DeletionImpactGroup {
  key: 'placements' | 'issues' | 'signoff' | 'publishedPackages' | 'objects';
  label: string;
  detail: string;
  items: string[];
}

export interface DeletionPlan {
  record: DeletionRecord;
  groups: DeletionImpactGroup[];
  /** Number of live references the delete will touch (zero = empty record). */
  totalReferences: number;
  /**
   * True only when nothing at all changes beyond the record itself: no
   * placements, cascaded or detached findings, finding links, readiness
   * sign-off regression, and no referenced published packages. Sign-off and
   * export-ledger impacts must count here so the “nothing else references
   * this record” banner can never contradict the groups below it.
   */
  isolated: boolean;
}

function isIsolatedPlan(state: WorkspaceState, record: DeletionRecord): boolean {
  if (record.placements.length > 0 || record.cascadeIssues.length > 0 || record.detachments.length > 0) return false;
  if (record.publishedPackageIds.length > 0) return false;
  if (state.project.stage === 'ready') return false;
  if (record.kind === 'issue' && record.issue && (record.issue.zoneId || record.issue.artifactId)) return false;
  return true;
}

export type DeletionStatus = 'recoverable' | 'expired' | 'restored';

export function getDeletionStatus(record: DeletionRecord, now = Date.now()): DeletionStatus {
  if (record.restoredAt) return 'restored';
  return now <= new Date(record.expiresAt).getTime() ? 'recoverable' : 'expired';
}

export function getDeletionRecord(state: WorkspaceState, recordId: string): DeletionRecord | undefined {
  return state.deletionRecords.find((record) => record.id === recordId);
}

function zoneName(state: WorkspaceState, zoneId: string): string {
  return state.zones.find((zone) => zone.id === zoneId)?.name ?? 'a removed zone';
}

function artifactTitle(state: WorkspaceState, artifactId: string): string {
  return state.artifacts.find((artifact) => artifact.id === artifactId)?.title ?? 'a removed object';
}

function publishedGroups(matched: PublishedPackage[]): DeletionImpactGroup[] {
  if (matched.length === 0) {
    return [{
      key: 'publishedPackages',
      label: 'Exported materials & history packages',
      detail: 'No previously exported package references this record.',
      items: ['No exported package will change — nothing previously downloaded is rewritten.'],
    }];
  }
  return [{
    key: 'publishedPackages',
    label: 'Exported materials & history packages',
    detail: `${matched.length} published package${matched.length === 1 ? '' : 's'} reference${matched.length === 1 ? 's' : ''} the affected graph.`,
    items: [
      ...matched.map((pkg) => `${pkg.fileName || 'Readiness snapshot'} · published ${new Date(pkg.publishedAt).toLocaleDateString()} — stays exactly as exported`),
      'Historical packages are frozen: this delete is appended to the audit trail, never written back into them.',
    ],
  }];
}

function signoffGroup(state: WorkspaceState): DeletionImpactGroup[] {
  if (state.project.stage !== 'ready') return [];
  return [{
    key: 'signoff',
    label: 'Readiness sign-off',
    detail: 'The plan currently carries a ready sign-off.',
    items: ['The plan returns to review and a new readiness check is required before another snapshot can be exported.'],
  }];
}

function buildRecord(
  kind: DeletionTargetKind,
  targetId: string,
  targetLabel: string,
  now: Date,
): DeletionRecord {
  return {
    id: createId('deletion'),
    kind,
    deletedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + RESTORE_WINDOW_MS).toISOString(),
    targetId,
    targetLabel,
    placements: [],
    cascadeIssues: [],
    detachments: [],
    publishedPackageIds: [],
  };
}

export function planArtifactDelete(state: WorkspaceState, artifactId: string, now = new Date()): DeletionPlan {
  const artifact = state.artifacts.find((candidate) => candidate.id === artifactId);
  if (!artifact) throw new Error('The selected object no longer exists.');

  const record = buildRecord('artifact', artifact.id, artifact.title, now);
  record.artifact = { ...artifact };
  state.zones
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .forEach((zone) => {
      zone.artifactIds.forEach((id, index) => {
        if (id === artifactId) {
          record.placements.push({ zoneId: zone.id, zoneName: zone.name, index, artifactId, artifactTitle: artifact.title, action: 'removed' });
        }
      });
    });
  record.cascadeIssues = state.issues.filter((issue) => issue.artifactId === artifactId);

  const issueIds = new Set(record.cascadeIssues.map((issue) => issue.id));
  record.publishedPackageIds = state.publishedPackages
    .filter((pkg) => pkg.artifactIds.includes(artifactId) || pkg.issueIds.some((id) => issueIds.has(id)))
    .map((pkg) => pkg.id);

  const groups: DeletionImpactGroup[] = [];
  if (record.placements.length) {
    groups.push({
      key: 'placements',
      label: 'Journey placements',
      detail: `${record.placements.length} placement${record.placements.length === 1 ? '' : 's'} disappear with the object.`,
      items: record.placements.map((placement) => `${placement.zoneName} · position ${placement.index + 1} — object leaves the visitor sequence`),
    });
  }
  if (record.cascadeIssues.length) {
    groups.push({
      key: 'issues',
      label: 'Review findings',
      detail: `${record.cascadeIssues.length} finding${record.cascadeIssues.length === 1 ? '' : 's'} linked only to this object ${record.cascadeIssues.length === 1 ? 'is' : 'are'} removed together with it.`,
      items: record.cascadeIssues.map((issue) => `[${issue.severity}] ${issue.title} · ${titleCase(issue.status)} — removed with the object (recoverable for 7 days)`),
    });
  }
  groups.push(...signoffGroup(state));
  groups.push(...publishedGroups(state.publishedPackages.filter((pkg) => record.publishedPackageIds.includes(pkg.id))));

  return {
    record,
    groups,
    totalReferences: record.placements.length + record.cascadeIssues.length,
    isolated: isIsolatedPlan(state, record),
  };
}

export function planZoneDelete(state: WorkspaceState, zoneId: string, now = new Date()): DeletionPlan {
  const zone = state.zones.find((candidate) => candidate.id === zoneId);
  if (!zone) throw new Error('The selected exhibition area no longer exists.');

  const record = buildRecord('zone', zone.id, zone.name, now);
  record.zone = { ...zone };
  zone.artifactIds.forEach((artifactId, index) => {
    record.placements.push({ zoneId: zone.id, zoneName: zone.name, index, artifactId, artifactTitle: artifactTitle(state, artifactId), action: 'detached' });
  });
  state.issues.forEach((issue) => {
    if (issue.zoneId === zoneId) {
      record.detachments.push({ issueId: issue.id, issueTitle: issue.title, field: 'zoneId' });
    }
  });

  const detachedIssueIds = new Set(record.detachments.map((detachment) => detachment.issueId));
  record.publishedPackageIds = state.publishedPackages
    .filter((pkg) => pkg.zoneId === zoneId
      || pkg.zoneIds?.includes(zoneId)
      || pkg.issueIds.some((id) => detachedIssueIds.has(id)))
    .map((pkg) => pkg.id);

  const groups: DeletionImpactGroup[] = [{
    key: 'objects',
    label: 'Objects in the area',
    detail: record.placements.length
      ? `${record.placements.length} placed object${record.placements.length === 1 ? '' : 's'} return${record.placements.length === 1 ? 's' : ''} to the unplaced queue; no object record is deleted.`
      : 'This area currently has no placed objects.',
    items: record.placements.length
      ? record.placements.map((placement) => `${placement.artifactTitle} · position ${placement.index + 1} — returns to the unplaced object queue`)
      : ['No objects are placed in this area.'],
  }];
  if (record.detachments.length) {
    groups.push({
      key: 'issues',
      label: 'Review findings',
      detail: `${record.detachments.length} finding${record.detachments.length === 1 ? '' : 's'} linked to this area ${record.detachments.length === 1 ? 'loses' : 'lose'} the area link but ${record.detachments.length === 1 ? 'stays' : 'stay'} open.`,
      items: record.detachments.map((detachment) => `${detachment.issueTitle} — finding is kept, only the area link is removed`),
    });
  }
  groups.push(...signoffGroup(state));
  groups.push(...publishedGroups(state.publishedPackages.filter((pkg) => record.publishedPackageIds.includes(pkg.id))));

  return {
    record,
    groups,
    totalReferences: record.placements.length + record.detachments.length,
    isolated: isIsolatedPlan(state, record),
  };
}

export function planIssueDelete(state: WorkspaceState, issueId: string, now = new Date()): DeletionPlan {
  const issue = state.issues.find((candidate) => candidate.id === issueId);
  if (!issue) throw new Error('The selected finding no longer exists.');

  const record = buildRecord('issue', issue.id, issue.title, now);
  record.issue = { ...issue };
  record.publishedPackageIds = state.publishedPackages
    .filter((pkg) => pkg.issueIds.includes(issueId))
    .map((pkg) => pkg.id);

  const links: string[] = [];
  if (issue.zoneId) links.push(`area “${zoneName(state, issue.zoneId)}”`);
  if (issue.artifactId) links.push(`object “${artifactTitle(state, issue.artifactId)}”`);

  const groups: DeletionImpactGroup[] = [{
    key: 'issues',
    label: 'Finding links',
    detail: 'Only the finding itself is removed; linked objects and areas are untouched.',
    items: links.length ? [`Linked to ${links.join(' and ')}.`] : ['This finding is not linked to any object or area.'],
  }];
  groups.push(...signoffGroup(state));
  groups.push(...publishedGroups(state.publishedPackages.filter((pkg) => record.publishedPackageIds.includes(pkg.id))));

  return { record, groups, totalReferences: links.length, isolated: isIsolatedPlan(state, record) };
}

export function planDelete(state: WorkspaceState, kind: DeletionTargetKind, targetId: string, now = new Date()): DeletionPlan {
  if (kind === 'artifact') return planArtifactDelete(state, targetId, now);
  if (kind === 'zone') return planZoneDelete(state, targetId, now);
  return planIssueDelete(state, targetId, now);
}

/** Applies a planned deletion. The record is kept for audit and recovery. */
export function applyDeletion(state: WorkspaceState, record: DeletionRecord): WorkspaceState {
  let next: WorkspaceState;
  if (record.kind === 'artifact') {
    next = {
      ...state,
      artifacts: state.artifacts.filter((artifact) => artifact.id !== record.targetId),
      zones: state.zones.map((zone) => ({ ...zone, artifactIds: zone.artifactIds.filter((id) => id !== record.targetId) })),
      issues: state.issues.filter((issue) => issue.artifactId !== record.targetId),
    };
  } else if (record.kind === 'zone') {
    next = {
      ...state,
      zones: state.zones.filter((zone) => zone.id !== record.targetId),
      issues: state.issues.map((issue) => (issue.zoneId === record.targetId ? { ...issue, zoneId: undefined } : issue)),
    };
  } else {
    next = { ...state, issues: state.issues.filter((issue) => issue.id !== record.targetId) };
  }
  return { ...next, deletionRecords: [record, ...state.deletionRecords] };
}

function conflict(
  id: string,
  severity: RestoreConflict['severity'],
  subject: RestoreConflict['subject'],
  subjectLabel: string,
  message: string,
  options: RestoreDecision[],
  decision: RestoreDecision = options[0],
): RestoreConflict {
  return { id, severity, subject, subjectLabel, message, options, decision };
}

export interface RestoreAnalysis {
  record: DeletionRecord;
  status: DeletionStatus;
  conflicts: RestoreConflict[];
  hasBlocking: boolean;
}

export function analyzeRestore(state: WorkspaceState, recordId: string, now = new Date()): RestoreAnalysis {
  const record = getDeletionRecord(state, recordId);
  if (!record) throw new Error('This deletion record no longer exists.');
  const status = getDeletionStatus(record, now.getTime());
  const conflicts: RestoreConflict[] = [];

  if (record.kind === 'artifact' && record.artifact) {
    // The primary object itself is about to come back, so its own id must not
    // count as a missing link target for the findings cascaded with it.
    analyzeArtifactRestore(state, record, conflicts, new Set([record.targetId]), new Set());
  } else if (record.kind === 'zone' && record.zone) {
    analyzeZoneRestore(state, record, conflicts, new Set([record.targetId]));
  } else if (record.kind === 'issue' && record.issue) {
    analyzeIssueLinks(state, record.issue, conflicts);
  }

  return { record, status, conflicts, hasBlocking: conflicts.some((item) => item.severity === 'blocking') };
}

function analyzeArtifactRestore(
  state: WorkspaceState,
  record: DeletionRecord,
  conflicts: RestoreConflict[],
  restoringArtifactIds: Set<string>,
  restoringZoneIds: Set<string>,
): void {
  const stored = record.artifact as Artifact;
  const sameId = state.artifacts.find((artifact) => artifact.id === stored.id);
  if (sameId && sameId.updatedAt !== stored.updatedAt) {
    conflicts.push(conflict(
      'primary-record',
      'blocking',
      'record',
      stored.title,
      `An object with the same ID (${stored.accessionId}) exists and was edited after the deletion (${new Date(sameId.updatedAt).toLocaleDateString()}). Restoring overwrites the current object record with the deleted version.`,
      ['skip', 'overwrite'],
      'skip',
    ));
  } else if (!sameId) {
    const accessionHolder = state.artifacts.find(
      (artifact) => normalizeAccessionId(artifact.accessionId) === normalizeAccessionId(stored.accessionId),
    );
    if (accessionHolder) {
      conflicts.push(conflict(
        'accession-collision',
        'blocking',
        'record',
        stored.title,
        `Accession ID ${stored.accessionId} is now used by another object, “${accessionHolder.title}”. The deleted object cannot be brought back while that identifier is taken — edit or remove the newer object first.`,
        ['skip'],
        'skip',
      ));
    }
  }

  record.placements.forEach((placement, index) => {
    const zone = state.zones.find((candidate) => candidate.id === placement.zoneId);
    if (!zone) {
      conflicts.push(conflict(
        `placement-${index}`,
        'warning',
        'placement',
        placement.zoneName,
        `The area “${placement.zoneName}” no longer exists, so the placement at position ${placement.index + 1} cannot be restored. The object can still be returned to the unplaced queue.`,
        ['skip'],
      ));
      return;
    }
    if (zone.artifactIds.includes(stored.id)) {
      conflicts.push(conflict(
        `placement-${index}`,
        'warning',
        'placement',
        zone.name,
        `The object is already placed in “${zone.name}” (the plan changed after the deletion). Keep the current placement, or move it back to recorded position ${placement.index + 1}.`,
        ['skip', 'overwrite'],
        'skip',
      ));
      return;
    }
    const otherZone = state.zones.find((candidate) => candidate.artifactIds.includes(stored.id));
    if (otherZone) {
      conflicts.push(conflict(
        `placement-${index}`,
        'warning',
        'placement',
        otherZone.name,
        `The object was placed in “${otherZone.name}” after the deletion. Leave it there, or pull it back into “${zone.name}” at position ${placement.index + 1}.`,
        ['skip', 'overwrite'],
        'skip',
      ));
    }
  });

  record.cascadeIssues.forEach((issue, index) => analyzeCascadeIssueRestore(state, issue, index, conflicts, restoringArtifactIds, restoringZoneIds));
}

function analyzeCascadeIssueRestore(
  state: WorkspaceState,
  issue: ReviewIssue,
  index: number,
  conflicts: RestoreConflict[],
  restoringArtifactIds: Set<string>,
  restoringZoneIds: Set<string>,
): void {
  if (state.issues.some((candidate) => candidate.id === issue.id)) {
    conflicts.push(conflict(
      `cascade-issue-${index}`,
      'blocking',
      'issue',
      issue.title,
      `A finding with the same record ID, “${issue.title}”, already exists on the review desk.`,
      ['skip', 'overwrite'],
      'skip',
    ));
    return;
  }
  analyzeIssueLinks(state, issue, conflicts, `cascade-issue-${index}`, restoringArtifactIds, restoringZoneIds);
}

function analyzeIssueLinks(
  state: WorkspaceState,
  issue: ReviewIssue,
  conflicts: RestoreConflict[],
  idPrefix = 'issue-link',
  extraArtifactIds: Set<string> = new Set(),
  extraZoneIds: Set<string> = new Set(),
): void {
  if (issue.zoneId && !extraZoneIds.has(issue.zoneId) && !state.zones.some((zone) => zone.id === issue.zoneId)) {
    conflicts.push(conflict(
      `${idPrefix}-zone`,
      'warning',
      'zone',
      issue.title,
      `The area this finding was linked to no longer exists. The finding can be restored without the area link.`,
      ['detach', 'skip'],
      'detach',
    ));
  }
  if (issue.artifactId && !extraArtifactIds.has(issue.artifactId) && !state.artifacts.some((artifact) => artifact.id === issue.artifactId)) {
    conflicts.push(conflict(
      `${idPrefix}-artifact`,
      'warning',
      'record',
      issue.title,
      `The object this finding was linked to no longer exists. The finding can be restored without the object link.`,
      ['detach', 'skip'],
      'detach',
    ));
  }
}

function analyzeZoneRestore(state: WorkspaceState, record: DeletionRecord, conflicts: RestoreConflict[], restoringZoneIds: Set<string>): void {
  void restoringZoneIds;
  const stored = record.zone as Zone;
  const sameId = state.zones.find((zone) => zone.id === stored.id);
  if (sameId) {
    conflicts.push(conflict(
      'zone-record',
      'blocking',
      'zone',
      stored.name,
      `An area with the same ID, “${sameId.name}”, was created after the deletion. Restoring replaces the current area with the deleted version.`,
      ['skip', 'overwrite'],
      'skip',
    ));
  } else {
    const sameName = state.zones.find((zone) => zone.name === stored.name || zone.shortLabel === stored.shortLabel);
    if (sameName) {
      conflicts.push(conflict(
        'zone-name',
        'warning',
        'zone',
        stored.name,
        `Another area, “${sameName.name}”, now uses the same name. The deleted area can still be restored with its recorded name.`,
        ['restore', 'skip'],
        'restore',
      ));
    }
    const sequenceHolder = state.zones.find((zone) => zone.sequence === stored.sequence);
    if (sequenceHolder) {
      conflicts.push(conflict(
        'zone-sequence',
        'warning',
        'zone',
        stored.name,
        `Sequence position ${stored.sequence + 1} is now used by “${sequenceHolder.name}”. Append the restored area at the end, or insert it at its recorded position and shift later areas.`,
        ['restore', 'overwrite'],
        'restore',
      ));
    }
  }

  record.placements.forEach((placement, index) => {
    const artifact = state.artifacts.find((candidate) => candidate.id === placement.artifactId);
    if (!artifact) {
      conflicts.push(conflict(
        `zone-placement-${index}`,
        'warning',
        'placement',
        placement.artifactTitle,
        `Object “${placement.artifactTitle}” was deleted after the area was deleted, so its placement cannot be restored.`,
        ['skip'],
      ));
      return;
    }
    const currentZone = state.zones.find((zone) => zone.artifactIds.includes(artifact.id));
    if (currentZone && currentZone.id !== stored.id) {
      conflicts.push(conflict(
        `zone-placement-${index}`,
        'warning',
        'placement',
        artifact.title,
        `“${artifact.title}” is now placed in “${currentZone.name}”. Leave it there, or pull it back into the restored area at position ${placement.index + 1}.`,
        ['skip', 'overwrite'],
        'skip',
      ));
    }
  });

  record.detachments.forEach((detachment, index) => {
    const issue = state.issues.find((candidate) => candidate.id === detachment.issueId);
    if (!issue) {
      conflicts.push(conflict(
        `detachment-${index}`,
        'warning',
        'issue',
        detachment.issueTitle,
        `Finding “${detachment.issueTitle}” was also deleted in the meantime and cannot be relinked.`,
        ['skip'],
      ));
      return;
    }
    if (issue.zoneId && issue.zoneId !== stored.id) {
      conflicts.push(conflict(
        `detachment-${index}`,
        'warning',
        'issue',
        issue.title,
        `Finding “${issue.title}” was linked to another area after the deletion. Keep its current link, or relink it to the restored area.`,
        ['skip', 'overwrite'],
        'skip',
      ));
    }
  });
}

export interface CommitRestoreResult {
  state: WorkspaceState;
  report: RestoreReport;
  /** False when every restorable part was skipped because of conflicts. */
  applied: boolean;
}

export function commitRestore(
  state: WorkspaceState,
  recordId: string,
  decisions: Record<string, RestoreDecision>,
  now = new Date(),
): CommitRestoreResult {
  const analysis = analyzeRestore(state, recordId, now);
  const { record, status } = analysis;
  if (status !== 'recoverable') throw new Error(status === 'expired' ? 'The recovery window for this deletion has closed.' : 'This deletion has already been restored.');

  const decisionFor = (conflictItem: RestoreConflict): RestoreDecision => decisions[conflictItem.id] ?? conflictItem.decision;
  const lines: RestoreSummaryLine[] = [];

  const unresolvedBlocking = analysis.conflicts
    .filter((item) => item.severity === 'blocking' && !(item.id in decisions))
    .map((item) => item.subjectLabel);
  if (unresolvedBlocking.length) {
    throw new Error(`Resolve the conflicts with “${unresolvedBlocking.join('”, “')}” before restoring; the current state was left untouched.`);
  }

  let next: WorkspaceState = state;
  let applied = true;

  if (record.kind === 'artifact' && record.artifact) {
    const outcome = restoreArtifact(state, analysis.conflicts, decisionFor, record, lines);
    next = outcome.state;
    applied = outcome.applied;
  } else if (record.kind === 'zone' && record.zone) {
    const outcome = restoreZone(state, analysis.conflicts, decisionFor, record, lines);
    next = outcome.state;
    applied = outcome.applied;
  } else if (record.kind === 'issue' && record.issue) {
    next = restoreIssueEntity(state, analysis.conflicts, decisionFor, record.issue, 'record', lines);
  }

  if (!applied) {
    return { state: next, report: { recordId, restoredAt: now.toISOString(), lines }, applied: false };
  }

  const report: RestoreReport = { recordId, restoredAt: now.toISOString(), lines };
  const deletionRecords = state.deletionRecords.map((item) =>
    item.id === recordId ? { ...item, restoredAt: now.toISOString() } : item,
  );
  return {
    state: { ...next, deletionRecords, restoreReports: [report, ...state.restoreReports].slice(0, 20) },
    report,
    applied: true,
  };
}

function lineFor(outcome: RestoreSummaryLine['outcome'], label: string): RestoreSummaryLine {
  return { label, outcome };
}

function resolveLinkConflicts(
  issue: ReviewIssue,
  conflicts: RestoreConflict[],
  decisionFor: (conflict: RestoreConflict) => RestoreDecision,
): ReviewIssue | null {
  const zoneConflict = conflicts.find((item) => item.id.endsWith('-zone') && item.subject === 'zone' && item.subjectLabel === issue.title);
  const artifactConflict = conflicts.find((item) => item.id.endsWith('-artifact') && item.subject === 'record' && item.subjectLabel === issue.title);
  let restored: ReviewIssue = { ...issue };
  if (zoneConflict && decisionFor(zoneConflict) === 'skip') return null;
  if (zoneConflict && decisionFor(zoneConflict) === 'detach') restored = { ...restored, zoneId: undefined };
  if (artifactConflict && decisionFor(artifactConflict) === 'skip') return null;
  if (artifactConflict && decisionFor(artifactConflict) === 'detach') restored = { ...restored, artifactId: undefined };
  return restored;
}

function restoreArtifact(
  state: WorkspaceState,
  conflicts: RestoreConflict[],
  decisionFor: (conflict: RestoreConflict) => RestoreDecision,
  record: DeletionRecord,
  lines: RestoreSummaryLine[],
): { state: WorkspaceState; applied: boolean } {
  const stored = record.artifact as Artifact;
  const primary = conflicts.find((item) => item.id === 'primary-record');
  const accession = conflicts.find((item) => item.id === 'accession-collision');
  const identicalExisting = state.artifacts.some((artifact) => artifact.id === stored.id);
  const primaryDecision = primary ? decisionFor(primary) : accession ? decisionFor(accession) : 'restore';

  let artifacts = [...state.artifacts];
  if (primaryDecision === 'overwrite') {
    artifacts = artifacts.map((artifact) => (artifact.id === stored.id ? stored : artifact));
    lines.push(lineFor('overwritten', `Object “${stored.title}” replaced the current version`));
  } else if (primaryDecision === 'skip') {
    lines.push(lineFor('skipped', `Object “${stored.title}” was not restored because of a live conflict`));
    record.placements.forEach((placement) => lines.push(lineFor('skipped', `Placement in “${placement.zoneName}” skipped with the object`)));
    record.cascadeIssues.forEach((issue) => lines.push(lineFor('skipped', `Finding “${issue.title}” skipped with the object`)));
    return { state, applied: false };
  } else if (!identicalExisting) {
    artifacts = [...artifacts, stored];
    lines.push(lineFor('restored', `Object “${stored.title}” returned to the collection`));
  } else {
    lines.push(lineFor('restored', `Object “${stored.title}” kept its current record`));
  }

  let zones = [...state.zones];
  const zoneMap = new Map(zones.map((zone) => [zone.id, zone]));
  record.placements.forEach((placement, index) => {
    const zone = zoneMap.get(placement.zoneId);
    if (!zone) return;
    const placementConflict = conflicts.find((item) => item.id === `placement-${index}` && item.subject === 'placement');
    const elsewhere = zones.some((candidate) => candidate.id !== zone.id && candidate.artifactIds.includes(stored.id));
    const inTarget = zone.artifactIds.includes(stored.id);

    if ((inTarget || elsewhere) && (!placementConflict || decisionFor(placementConflict) === 'skip')) {
      lines.push(lineFor('skipped', `Kept the current placement of “${stored.title}”`));
      return;
    }

    // A recorded position restore (or an explicit pull-back) removes the
    // object from every other area first, then inserts it at the target.
    let nextZones = (inTarget || elsewhere)
      ? zones.map((candidate) => ({ ...candidate, artifactIds: candidate.artifactIds.filter((id) => id !== stored.id) }))
      : zones;
    nextZones = nextZones.map((candidate) => {
      if (candidate.id !== zone.id) return candidate;
      const artifactIds = [...candidate.artifactIds];
      const insertAt = Math.min(placement.index, artifactIds.length);
      artifactIds.splice(insertAt, 0, stored.id);
      return { ...candidate, artifactIds };
    });
    nextZones.forEach((candidate) => zoneMap.set(candidate.id, candidate));
    zones = nextZones;
    lines.push(lineFor(
      inTarget || elsewhere ? 'overwritten' : 'restored',
      `Placed “${stored.title}” at position ${Math.min(placement.index, zone.artifactIds.length) + 1} in “${zone.name}”`,
    ));
  });

  let issues = [...state.issues];
  record.cascadeIssues.forEach((issue, index) => {
    const collision = conflicts.find((item) => item.id === `cascade-issue-${index}`);
    if (collision) {
      if (decisionFor(collision) === 'skip') {
        lines.push(lineFor('skipped', `Finding “${issue.title}” kept as-is on the review desk`));
        return;
      }
      issues = issues.map((candidate) => (candidate.id === issue.id ? issue : candidate));
      lines.push(lineFor('overwritten', `Finding “${issue.title}” replaced with the deleted version`));
      return;
    }
    const linkConflicts = conflicts.filter(
      (item) => (item.id === `cascade-issue-${index}-zone` || item.id === `cascade-issue-${index}-artifact`),
    );
    const restoredIssue = resolveLinkConflicts(issue, linkConflicts, decisionFor);
    if (!restoredIssue) {
      lines.push(lineFor('skipped', `Finding “${issue.title}” skipped because its link target is gone`));
      return;
    }
    issues = [...issues, restoredIssue];
    lines.push(lineFor(restoredIssue.zoneId === issue.zoneId && restoredIssue.artifactId === issue.artifactId ? 'restored' : 'detached', `Finding “${issue.title}” returned to the review desk`));
  });

  return { state: { ...state, artifacts, zones, issues }, applied: true };
}

function restoreZone(
  state: WorkspaceState,
  conflicts: RestoreConflict[],
  decisionFor: (conflict: RestoreConflict) => RestoreDecision,
  record: DeletionRecord,
  lines: RestoreSummaryLine[],
): { state: WorkspaceState; applied: boolean } {
  const stored = record.zone as Zone;
  const sameId = conflicts.find((item) => item.id === 'zone-record');
  if (sameId && decisionFor(sameId) === 'skip') {
    lines.push(lineFor('skipped', `Area “${stored.name}” was not restored because a newer area uses its ID`));
    return { state, applied: false };
  }

  let zone: Zone = { ...stored, artifactIds: [] };
  if (sameId && decisionFor(sameId) === 'overwrite') {
    lines.push(lineFor('overwritten', `Area “${stored.name}” replaced the current area`));
  } else {
    const sequenceConflict = conflicts.find((item) => item.id === 'zone-sequence');
    if (sequenceConflict && decisionFor(sequenceConflict) === 'overwrite') {
      lines.push(lineFor('restored', `Area “${stored.name}” retook sequence position ${stored.sequence + 1}`));
    } else if (sequenceConflict) {
      zone = { ...zone, sequence: state.zones.length };
      lines.push(lineFor('restored', `Area “${stored.name}” appended at sequence position ${zone.sequence + 1}`));
    } else {
      lines.push(lineFor('restored', `Area “${stored.name}” returned to the visitor journey`));
    }
  }

  let zones = sameId
    ? state.zones.map((candidate) => (candidate.id === stored.id ? { ...candidate, ...zone } : candidate))
    : [...state.zones, zone];
  const zoneIndexById = new Map(zones.map((candidate) => [candidate.id, candidate]));

  record.placements.forEach((placement, index) => {
    const artifactExists = state.artifacts.some((artifact) => artifact.id === placement.artifactId);
    const placementConflict = conflicts.find((item) => item.id === `zone-placement-${index}`);
    if (!artifactExists) return;
    if (placementConflict && decisionFor(placementConflict) === 'skip') {
      lines.push(lineFor('skipped', `“${placement.artifactTitle}” stayed in its current area`));
      return;
    }
    const pullBack = placementConflict && decisionFor(placementConflict) === 'overwrite';
    zones = zones.map((candidate) => {
      let artifactIds = candidate.artifactIds.filter((id) => (pullBack ? id !== placement.artifactId : true));
      if (candidate.id === stored.id) {
        const current = zoneIndexById.get(stored.id);
        if (current) artifactIds = [...current.artifactIds];
        const insertAt = Math.min(placement.index, artifactIds.length);
        artifactIds.splice(insertAt, 0, placement.artifactId);
      }
      return { ...candidate, artifactIds };
    });
    zones.forEach((candidate) => zoneIndexById.set(candidate.id, candidate));
    lines.push(lineFor(pullBack ? 'overwritten' : 'restored', `“${placement.artifactTitle}” placed at position ${placement.index + 1} in “${stored.name}”`));
  });

  let issues = state.issues;
  record.detachments.forEach((detachment, index) => {
    const issue = issues.find((candidate) => candidate.id === detachment.issueId);
    if (!issue) return;
    const detachmentConflict = conflicts.find((item) => item.id === `detachment-${index}`);
    if (detachmentConflict && decisionFor(detachmentConflict) === 'skip') {
      lines.push(lineFor('skipped', `Finding “${issue.title}” kept its current area link`));
      return;
    }
    if (!issue.zoneId || (detachmentConflict && decisionFor(detachmentConflict) === 'overwrite')) {
      issues = issues.map((candidate) => (candidate.id === issue.id ? { ...candidate, zoneId: stored.id } : candidate));
      lines.push(lineFor('restored', `Finding “${issue.title}” relinked to “${stored.name}”`));
    }
  });

  return { state: { ...state, zones, issues }, applied: true };
}

function restoreIssueEntity(
  state: WorkspaceState,
  conflicts: RestoreConflict[],
  decisionFor: (conflict: RestoreConflict) => RestoreDecision,
  issue: ReviewIssue,
  label: string,
  lines: RestoreSummaryLine[],
): WorkspaceState {
  const linkConflicts = conflicts.filter((item) => item.id === 'issue-link-zone' || item.id === 'issue-link-artifact');
  const restored = resolveLinkConflicts(issue, linkConflicts, decisionFor);
  if (!restored) {
    lines.push(lineFor('skipped', `Finding “${issue.title}” skipped because its link targets are gone`));
    return state;
  }
  lines.push(lineFor(label === 'record' ? 'restored' : 'restored', `Finding “${issue.title}” returned to the review desk`));
  return { ...state, issues: [...state.issues, restored] };
}

/** Removes deletion records and restore reports past the audit horizon. */
export function pruneDeletionHistory(state: WorkspaceState, now = Date.now()): WorkspaceState {
  const deletionRecords = state.deletionRecords.filter(
    (record) => new Date(record.deletedAt).getTime() + AUDIT_HORIZON_MS > now,
  );
  const horizon = new Date(now - AUDIT_HORIZON_MS).toISOString();
  const restoreReports = state.restoreReports.filter((report) => report.restoredAt >= horizon);
  if (deletionRecords.length === state.deletionRecords.length && restoreReports.length === state.restoreReports.length) {
    return state;
  }
  return { ...state, deletionRecords, restoreReports };
}

// Local copy to avoid a cycle through the formatter module.
function titleCase(value: string): string {
  return value.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}
