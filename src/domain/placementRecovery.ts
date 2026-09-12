import { canPlaceArtifact } from './journeyAnalysis';
import type {
  Artifact,
  ExportDependencyRef,
  PlacementRemoval,
  RelatedFindingRef,
  RemovalPlan,
  RestoreConflictReason,
  ReviewIssue,
  SnapshotPublication,
  WorkspaceState,
  Zone,
} from './models';

export interface RestoreOutcome {
  kind: 'restored' | 'noop' | 'review';
  reason?: RestoreConflictReason;
  detail?: string;
}

export function zoneFingerprint(zone: Zone): string {
  return `${zone.lowLight ? 1 : 0}|${zone.hasSeating ? 1 : 0}|${zone.capacityMinutes}|${zone.maxObjects}|${zone.sequence}|${zone.artifactIds.join('>')}`;
}

export function artifactFingerprint(artifact: Artifact): string {
  // updatedAt plus the placement-affecting fields, so an edit that re-stamps
  // updatedAt without touching placement properties is still detected.
  return [
    artifact.updatedAt,
    artifact.dwellMinutes,
    artifact.sensitivity,
    artifact.accessibilityNeed,
    artifact.narrativeRole,
    artifact.isKeyObject,
    artifact.dimensions.width,
    artifact.dimensions.height,
    artifact.dimensions.depth,
  ].join('|');
}

function relatedFindings(issues: ReviewIssue[], artifactId: string, zoneId: string): RelatedFindingRef[] {
  return issues
    .filter((issue) => issue.artifactId === artifactId || (issue.zoneId === zoneId && !issue.artifactId))
    .map((issue) => ({
      issueId: issue.id,
      title: issue.title,
      severity: issue.severity,
      status: issue.status,
    }));
}

function exportDependencies(publications: SnapshotPublication[], artifactId: string): ExportDependencyRef[] {
  return publications
    .filter((publication) => publication.artifactIds.includes(artifactId))
    .map((publication) => ({
      snapshotGeneratedAt: publication.generatedAt,
      readinessScore: publication.readinessScore,
      includesObject: true,
    }));
}

/** Previews the transaction that a removal would create, for the confirm step. */
export function planPlacementRemoval(state: WorkspaceState, artifactId: string): RemovalPlan | null {
  const artifact = state.artifacts.find((candidate) => candidate.id === artifactId);
  const zone = state.zones.find((candidate) => candidate.artifactIds.includes(artifactId));
  if (!artifact || !zone) return null;
  const index = zone.artifactIds.indexOf(artifactId);
  const byId = new Map(state.artifacts.map((candidate) => [candidate.id, candidate]));
  const before = zone.artifactIds[index - 1] ? byId.get(zone.artifactIds[index - 1]) : undefined;
  const after = zone.artifactIds[index + 1] ? byId.get(zone.artifactIds[index + 1]) : undefined;
  return {
    artifactId,
    artifactTitle: artifact.title,
    zoneId: zone.id,
    zoneName: zone.name,
    index,
    neighborBeforeTitle: before?.title ?? null,
    neighborAfterTitle: after?.title ?? null,
    relatedFindings: relatedFindings(state.issues, artifactId, zone.id),
    exportDependencies: exportDependencies(state.publications, artifactId),
  };
}

export function createPlacementRemoval(state: WorkspaceState, artifactId: string, id: string, at = new Date()): PlacementRemoval | null {
  const artifact = state.artifacts.find((candidate) => candidate.id === artifactId);
  const zone = state.zones.find((candidate) => candidate.artifactIds.includes(artifactId));
  if (!artifact || !zone) return null;
  const index = zone.artifactIds.indexOf(artifactId);
  return {
    id,
    artifactId,
    artifactVersion: artifactFingerprint(artifact),
    zoneId: zone.id,
    zoneVersion: zoneFingerprint(zone),
    index,
    neighborBeforeId: zone.artifactIds[index - 1] ?? null,
    neighborAfterId: zone.artifactIds[index + 1] ?? null,
    zoneOrderAfterRemoval: zone.artifactIds.filter((candidate) => candidate !== artifactId),
    relatedFindings: relatedFindings(state.issues, artifactId, zone.id),
    exportDependencies: exportDependencies(state.publications, artifactId),
    status: 'held',
    createdAt: at.toISOString(),
    reviewAttempts: 0,
  };
}

/** State with the placement removed but the object retained in the collection. */
export function applyPlacementRemoval(state: WorkspaceState, removal: PlacementRemoval): WorkspaceState {
  return {
    ...state,
    zones: state.zones.map((zone) =>
      zone.id === removal.zoneId
        ? { ...zone, artifactIds: zone.artifactIds.filter((id) => id !== removal.artifactId) }
        : zone,
    ),
    removals: [removal, ...state.removals],
  };
}

const RESTORED_RECORD_LIMIT = 20;

/** Prunes the oldest restored records while keeping every held/in-review one. */
export function pruneRestoredRemovals(removals: PlacementRemoval[], limit = RESTORED_RECORD_LIMIT): PlacementRemoval[] {
  const restored = removals
    .filter((removal) => removal.status === 'restored')
    .sort((a, b) => (b.restoredAt ?? b.createdAt).localeCompare(a.restoredAt ?? a.createdAt));
  const keptRestored = new Set(restored.slice(0, limit).map((removal) => removal.id));
  return removals.filter((removal) => removal.status !== 'restored' || keptRestored.has(removal.id));
}

/** Placement-affecting properties of the zone as they were at removal time. */
function parseZoneVersion(version: string): { lowLight: boolean; hasSeating: boolean; capacityMinutes: number; maxObjects: number; sequence: number } {
  const [lowLight, hasSeating, capacityMinutes, maxObjects, sequence] = version.split('|');
  return {
    lowLight: lowLight === '1',
    hasSeating: hasSeating === '1',
    capacityMinutes: Number(capacityMinutes),
    maxObjects: Number(maxObjects),
    sequence: Number(sequence),
  };
}

function insertAt(zone: Zone, artifactId: string, index: number): Zone {
  const targetIndex = Math.max(0, Math.min(index, zone.artifactIds.length));
  const artifactIds = [...zone.artifactIds];
  artifactIds.splice(targetIndex, 0, artifactId);
  return { ...zone, artifactIds };
}

/**
 * Determines where the artifact should return to.
 *
 * 1. Exact slot: the zone's surviving sequence is unchanged since removal.
 * 2. Neighbor slot: the recorded neighbours are still adjacent to each other.
 * 3. Otherwise the position is ambiguous and must go to manual review.
 */
export function resolveRestoreIndex(zone: Zone, removal: PlacementRemoval): { index: number } | { ambiguous: true } {
  if (zone.artifactIds.join('|') === removal.zoneOrderAfterRemoval.join('|')) {
    return { index: removal.index };
  }
  const { neighborBeforeId, neighborAfterId } = removal;
  if (neighborBeforeId === null && neighborAfterId === null) {
    // The object was the zone's only placement, so there is no neighbor to
    // anchor against. The exact-sequence branch above already handled a still
    // empty zone; reaching here means other objects were added after removal,
    // so index 0 would be a blind insertion — require manual review.
    return { ambiguous: true };
  }
  if (neighborBeforeId === null) {
    // The object led the zone: its old after-neighbor must still lead it.
    const afterIndex = zone.artifactIds.indexOf(neighborAfterId as string);
    return afterIndex === 0 ? { index: 0 } : { ambiguous: true };
  }
  if (neighborAfterId === null) {
    // The object closed the zone: its old before-neighbor must still close it.
    const beforeIndex = zone.artifactIds.indexOf(neighborBeforeId);
    return beforeIndex === zone.artifactIds.length - 1 ? { index: zone.artifactIds.length } : { ambiguous: true };
  }
  const beforeIndex = zone.artifactIds.indexOf(neighborBeforeId);
  const afterIndex = zone.artifactIds.indexOf(neighborAfterId);
  if (beforeIndex === -1 || afterIndex === -1) return { ambiguous: true };
  // The two anchors must still be next to each other; otherwise something was
  // inserted between them and we cannot choose a "deterministic" slot.
  if (afterIndex !== beforeIndex + 1) return { ambiguous: true };
  return { index: afterIndex };
}

function dwellOf(zone: Zone, artifacts: Artifact[]): number {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  return zone.artifactIds.reduce((total, id) => total + (byId.get(id)?.dwellMinutes ?? 0), 0);
}

function review(removal: PlacementRemoval, reason: RestoreConflictReason, detail: string): PlacementRemoval {
  return {
    ...removal,
    status: 'in-review',
    conflictReason: reason,
    conflictDetail: detail,
    reviewAttempts: removal.reviewAttempts + 1,
  };
}

function publicationsAfterRemoval(state: WorkspaceState, removal: PlacementRemoval): SnapshotPublication[] {
  // A snapshot frozen after the removal captured the journey without the
  // object (or with the zone materially changed): restoring would diverge
  // from what was published, so the record goes to review instead.
  return state.publications.filter(
    (publication) =>
      publication.generatedAt > removal.createdAt
      && (publication.artifactIds.includes(removal.artifactId) || publication.zoneIds.includes(removal.zoneId)),
  );
}

export interface RestoreOptions {
  /**
   * Curator sign-off for a record that is already `in-review`. Bypasses the
   * soft checks (object edited, zone reconfigured, post-removal publication)
   * but never the hard guarantees: no duplicates, existing object and zone,
   * a deterministic slot, and current constraint compliance.
   */
  approved?: boolean;
}

/**
 * Evaluates a restore attempt without mutating state. The original record is
 * always preserved: a successful restore is marked `restored`, every conflict
 * moves the record to `in-review` for a curator, and a repeated restore is a
 * no-op so no duplicate placement can ever be created.
 */
export function evaluateRestore(
  state: WorkspaceState,
  removalId: string,
  at: Date = new Date(),
  options: RestoreOptions = {},
): { outcome: RestoreOutcome; next: WorkspaceState } {
  const approved = Boolean(options.approved);
  const hold = (reason: RestoreConflictReason, detail: string) => ({
    outcome: { kind: 'review' as const, reason, detail },
    next: {
      ...state,
      removals: state.removals.map((removal) =>
        removal.id === removalId ? review(removal, reason, detail) : removal,
      ),
    },
  });

  const removal = state.removals.find((candidate) => candidate.id === removalId);
  if (!removal) {
    return { outcome: { kind: 'noop', reason: 'not-held', detail: 'This removal record no longer exists.' }, next: state };
  }
  if (removal.status === 'restored') {
    // Repeated restore must not produce a second placement.
    return { outcome: { kind: 'noop', reason: 'not-held', detail: 'This placement was already restored.' }, next: state };
  }
  // Curator sign-off is only meaningful for a record that went through review.
  const signedOff = approved && removal.status === 'in-review';

  const artifact = state.artifacts.find((candidate) => candidate.id === removal.artifactId);
  if (!artifact) {
    return hold('object-missing', `${removal.artifactId} has been deleted from the collection since removal.`);
  }
  const zone = state.zones.find((candidate) => candidate.id === removal.zoneId);
  if (!zone) {
    return hold('zone-missing', `The original exhibition zone no longer exists.`);
  }

  const alreadyPlacedZone = state.zones.find((candidate) => candidate.artifactIds.includes(removal.artifactId));
  if (alreadyPlacedZone) {
    return hold(
      'already-placed',
      `The object is currently placed in ${alreadyPlacedZone.name}; the original record was kept without overwriting it.`,
    );
  }

  if (!signedOff && artifactFingerprint(artifact) !== removal.artifactVersion) {
    return hold('object-modified', `${artifact.title} was edited after removal; confirm its properties still suit the original zone.`);
  }

  const capturedZone = parseZoneVersion(removal.zoneVersion);
  if (
    !signedOff && (
      zone.lowLight !== capturedZone.lowLight
      || zone.hasSeating !== capturedZone.hasSeating
      || zone.capacityMinutes !== capturedZone.capacityMinutes
      || zone.maxObjects !== capturedZone.maxObjects
      || zone.sequence !== capturedZone.sequence
    )
  ) {
    return hold('constraint-violation', `The configuration of ${zone.name} changed since the object was removed; verify limits before restoring.`);
  }

  const slot = resolveRestoreIndex(zone, removal);
  if ('ambiguous' in slot) {
    // Even curator sign-off cannot invent a position: the slot must be
    // derivable from surviving neighbors or the exact recorded index.
    return hold('position-ambiguous', `The neighbor sequence in ${zone.name} changed; a curator must choose the return position.`);
  }

  const candidateZone = insertAt(zone, artifact.id, slot.index);

  // A publication frozen after the removal captures the object's absence.
  // Restoring diverges from that package; signed-off review may accept the
  // divergence, and the publication itself is never rewritten either way.
  if (!signedOff) {
    const stalePublications = publicationsAfterRemoval(state, removal);
    if (stalePublications.length > 0) {
      return hold(
        'export-dependency-stale',
        `${stalePublications.length} published snapshot${stalePublications.length === 1 ? '' : 's'} created after this removal would diverge from the restored journey. Published content is left untouched.`,
      );
    }
  }

  // Hard checks always apply, with or without sign-off.
  const preview = canPlaceArtifact(artifact, candidateZone);
  if (preview.some((finding) => finding.type === 'error')) {
    return hold('constraint-violation', preview.find((finding) => finding.type === 'error')?.detail ?? 'The placement now violates an exhibition constraint.');
  }
  const projectedDwell = dwellOf(candidateZone, state.artifacts);
  if (candidateZone.artifactIds.length > candidateZone.maxObjects || projectedDwell > candidateZone.capacityMinutes) {
    return hold('constraint-violation', `${zone.name} cannot take the object: restoring would exceed its object or dwell limit.`);
  }

  const timestamp = at.toISOString();
  const next: WorkspaceState = {
    ...state,
    zones: state.zones.map((candidate) => (candidate.id === zone.id ? candidateZone : candidate)),
    removals: pruneRestoredRemovals(state.removals.map((candidate) =>
      candidate.id === removal.id
        ? { ...candidate, status: 'restored', conflictReason: undefined, conflictDetail: undefined, restoredAt: timestamp, reviewAttempts: candidate.reviewAttempts }
        : candidate,
    )),
  };
  return {
    outcome: { kind: 'restored', detail: `${artifact.title} returned to position ${slot.index + 1} in ${zone.name}${signedOff ? ' after review sign-off' : ''}.` },
    next,
  };
}

export const RESTORE_CONFLICT_LABELS: Record<RestoreConflictReason, string> = {
  'not-held': 'Nothing to restore',
  'object-missing': 'Object deleted',
  'zone-missing': 'Zone removed',
  'object-modified': 'Object modified',
  'already-placed': 'Already placed elsewhere',
  'position-ambiguous': 'Position conflict',
  'constraint-violation': 'Constraint violation',
  'export-dependency-stale': 'Export dependency',
};
