import { regressReadyProject, transitionIssue } from './transitions';
import { buildVisitorPath, type VisitorPathSummary } from './visitorPath';
import type { ExportRecord, ReviewIssue, WorkspaceState, Zone } from './models';

export class ZoneOrderConflictError extends Error {
  constructor(
    public readonly expectedSignature: string,
    public readonly actualSignature: string,
  ) {
    super('The zone order changed since this reorder was prepared. The staged order was not applied.');
    this.name = 'ZoneOrderConflictError';
  }
}

export class ZoneOrderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZoneOrderValidationError';
  }
}

export interface ZoneSequenceChange {
  zoneId: string;
  zoneName: string;
  shortLabel: string;
  fromIndex: number;
  toIndex: number;
}

export interface ZoneReorderImpact {
  changes: ZoneSequenceChange[];
  timelineBefore: VisitorPathSummary;
  timelineAfter: VisitorPathSummary;
  newHandoffs: string[];
  removedHandoffs: string[];
  staleExports: ExportRecord[];
  reReviewIssues: ReviewIssue[];
  readinessRegresses: boolean;
}

export interface ZoneReorderPreview {
  baseSignature: string;
  targetSignature: string;
  targetOrder: string[];
  isNoOp: boolean;
  impact: ZoneReorderImpact;
}

export type ZoneReorderPreviewResult =
  | { ok: true; preview: ZoneReorderPreview }
  | { ok: false; errors: string[] };

/**
 * Effective visit order for a set of zones. The sort is stable, so zones that
 * share a duplicate sequence keep their stored relative order — this is the
 * canonical order every downstream rule (preview, signature, commit) uses.
 */
export function normalizeZoneOrder(zones: Zone[]): Zone[] {
  return [...zones].sort((left, right) => left.sequence - right.sequence);
}

/** Digest of the effective visit order; changes whenever the order changes. */
export function zoneOrderSignature(zones: Zone[]): string {
  return normalizeZoneOrder(zones).map((zone) => zone.id).join('>');
}

function handoffPairs(zones: Zone[]): string[] {
  const ordered = normalizeZoneOrder(zones);
  return ordered.slice(1).map((zone, index) => `${ordered[index].shortLabel} → ${zone.shortLabel}`);
}

/**
 * Dry-run of a zone reorder. Never mutates state: it validates the proposed
 * permutation and derives every downstream effect (timeline, exported
 * materials, readiness, findings flagged for re-review) so the change can be
 * reviewed before it is committed.
 */
export function previewZoneReorder(state: WorkspaceState, targetOrder: string[]): ZoneReorderPreviewResult {
  const errors: string[] = [];
  const knownIds = new Set(state.zones.map((zone) => zone.id));
  const seen = new Set<string>();
  for (const id of targetOrder) {
    if (!knownIds.has(id) && !errors.includes('The staged order references a zone that no longer exists.')) {
      errors.push('The staged order references a zone that no longer exists.');
    }
    if (seen.has(id) && !errors.includes('Each zone can appear only once in the staged order.')) {
      errors.push('Each zone can appear only once in the staged order.');
    }
    seen.add(id);
  }
  if (seen.size !== knownIds.size || state.zones.some((zone) => !seen.has(zone.id))) {
    errors.push('Every zone must appear exactly once in the staged order.');
  }
  if (errors.length) return { ok: false, errors };

  const currentOrder = normalizeZoneOrder(state.zones);
  const baseSignature = zoneOrderSignature(state.zones);
  const zoneById = new Map(state.zones.map((zone) => [zone.id, zone]));
  const fromIndexById = new Map(currentOrder.map((zone, index) => [zone.id, index]));
  const sequenceById = new Map(targetOrder.map((id, index) => [id, index]));

  const changes: ZoneSequenceChange[] = targetOrder
    .map((id, toIndex) => {
      const zone = zoneById.get(id) as Zone;
      return { zoneId: id, zoneName: zone.name, shortLabel: zone.shortLabel, fromIndex: fromIndexById.get(id) as number, toIndex };
    })
    .filter((change) => change.fromIndex !== change.toIndex);

  const resequenced = state.zones.map((zone) => ({ ...zone, sequence: sequenceById.get(zone.id) as number }));
  const beforePairs = handoffPairs(state.zones);
  const afterPairs = handoffPairs(resequenced);

  const movedZoneIds = new Set(changes.map((change) => change.zoneId));
  const zoneOfArtifact = new Map<string, string>();
  for (const zone of state.zones) {
    for (const artifactId of zone.artifactIds) zoneOfArtifact.set(artifactId, zone.id);
  }

  const targetSignature = targetOrder.join('>');
  const impact: ZoneReorderImpact = {
    changes,
    timelineBefore: buildVisitorPath(state.zones, state.artifacts),
    timelineAfter: buildVisitorPath(resequenced, state.artifacts),
    newHandoffs: afterPairs.filter((pair) => !beforePairs.includes(pair)),
    removedHandoffs: beforePairs.filter((pair) => !afterPairs.includes(pair)),
    staleExports: state.exports.filter((record) => record.status === 'current' && record.zoneOrderSignature !== targetSignature),
    reReviewIssues: state.issues.filter((issue) => issue.status === 'resolved' && (
      (issue.zoneId !== undefined && movedZoneIds.has(issue.zoneId))
      || (issue.artifactId !== undefined && movedZoneIds.has(zoneOfArtifact.get(issue.artifactId) ?? ''))
    )),
    readinessRegresses: state.project.stage === 'ready' && changes.length > 0,
  };

  return {
    ok: true,
    preview: {
      baseSignature,
      targetSignature,
      targetOrder: [...targetOrder],
      isNoOp: targetSignature === baseSignature,
      impact,
    },
  };
}

/**
 * Commits a staged zone reorder as one transaction. The expected base
 * signature guards against concurrent changes: if the stored order no longer
 * matches the order the preview was built from, the commit refuses instead of
 * overwriting the newer order. On success every zone sequence is rewritten to
 * a clean 0..n-1 range (resolving duplicate sequences), exports generated
 * against the old order are marked stale, resolved findings linked to moved
 * zones are flagged for re-review, and a ready project regresses to review.
 * Any failure throws before a new state is produced, so the stored order and
 * its dependent outputs are left fully intact.
 */
export function applyZoneReorder(
  state: WorkspaceState,
  targetOrder: string[],
  expectedBaseSignature: string,
  at = new Date(),
): WorkspaceState {
  const currentSignature = zoneOrderSignature(state.zones);
  if (currentSignature !== expectedBaseSignature) {
    throw new ZoneOrderConflictError(expectedBaseSignature, currentSignature);
  }
  const result = previewZoneReorder(state, targetOrder);
  if (!result.ok) throw new ZoneOrderValidationError(result.errors.join(' '));
  const { preview } = result;
  if (preview.isNoOp) throw new ZoneOrderValidationError('The staged order matches the current sequence.');

  const sequenceById = new Map(preview.targetOrder.map((id, index) => [id, index]));
  const staleExportIds = new Set(preview.impact.staleExports.map((record) => record.id));
  const reReviewIssueIds = new Set(preview.impact.reReviewIssues.map((issue) => issue.id));

  const next: WorkspaceState = {
    ...state,
    zones: state.zones.map((zone) => ({ ...zone, sequence: sequenceById.get(zone.id) as number })),
    exports: state.exports.map((record) => staleExportIds.has(record.id) ? { ...record, status: 'stale' } : record),
    issues: state.issues.map((issue) => reReviewIssueIds.has(issue.id) ? transitionIssue(issue, 'in-progress', at) : issue),
  };
  return regressReadyProject(next);
}
