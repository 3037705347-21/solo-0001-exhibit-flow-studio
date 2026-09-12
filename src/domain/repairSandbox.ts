import { analyzeJourney } from './journeyAnalysis';
import type { Artifact, ConstraintFinding, ReviewIssue, WorkspaceState, Zone } from './models';
import type { PlanRevision } from './planVersion';
import { computePlanRevision } from './planVersion';

/**
 * Constraint repair sandbox.
 *
 * The sandbox turns journey constraint findings (capacity, density, light,
 * seating, narrative role, unplaced key objects) into a *deterministic* set of
 * candidate changes. Nothing here mutates the plan: candidates are previewed
 * and only applied once, atomically, against the revision they were computed
 * from. Key objects are never moved or unplaced by an automatic proposal.
 */

export type RepairConflictKind =
  | 'capacity'
  | 'density'
  | 'light'
  | 'seating'
  | 'missing-role'
  | 'unplaced-key';

export type RepairConflictSeverity = 'error' | 'warning';

export interface RepairConflict {
  id: string;
  kind: RepairConflictKind;
  severity: RepairConflictSeverity;
  title: string;
  detail: string;
  zoneId?: string;
  artifactId?: string;
  role?: Artifact['narrativeRole'];
}

export type RepairOperationKind = 'move' | 'unplace' | 'place';

export interface RepairOperation {
  kind: RepairOperationKind;
  artifactId: string;
  /** Destination zone for move/place. Absent when an object is returned to the queue. */
  zoneId?: string;
}

export type BlockedReasonCode =
  | 'key-object-protected'
  | 'no-light-compatible-zone'
  | 'no-seating-zone'
  | 'every-zone-full'
  | 'would-overload-target'
  | 'would-create-conflict'
  | 'last-role-carrier'
  | 'no-candidate-object';

export interface BlockedCondition {
  code: BlockedReasonCode;
  /** The artifact that could not be moved, when relevant. */
  artifactId?: string;
  /** The destination zone that rejected the artifact, when relevant. */
  zoneId?: string;
  message: string;
}

export interface AffectedMaterial {
  type: 'finding' | 'zone' | 'artifact' | 'readiness';
  id?: string;
  label: string;
  detail: string;
}

export interface RepairChange {
  id: string;
  operation: RepairOperation;
  artifactTitle: string;
  /** Origin zone name for move/unplace; omitted when placing from the queue. */
  fromZoneName?: string;
  /** Destination zone name for move/place. */
  toZoneName?: string;
  summary: string;
  reason: string;
  resolvesConflictIds: string[];
  affectedMaterials: AffectedMaterial[];
}

export interface RepairCaution {
  id: string;
  title: string;
  detail: string;
}

export interface RepairBlockedOption {
  conflictId: string;
  operation: RepairOperation;
  artifactTitle?: string;
  blocked: BlockedCondition;
}

export interface RepairProposal {
  revision: PlanRevision;
  conflicts: RepairConflict[];
  /** Minimal ordered set of changes that resolves every repairable conflict. */
  changes: RepairChange[];
  /** Unavailable options, shown for the conflicts that could not be repaired. */
  blockedOptions: RepairBlockedOption[];
  unresolvedConflictIds: string[];
  cautions: RepairCaution[];
  /** All targeted conflicts are resolved and no new block errors appear. */
  complete: boolean;
}

// ---------------------------------------------------------------------------
// Conflict extraction
// ---------------------------------------------------------------------------

/** Zone-level context notices ("lacks a context object") are not repair targets. */
function parseFindingKind(finding: ConstraintFinding): RepairConflictKind | null {
  if (finding.id.startsWith('capacity-')) return 'capacity';
  if (finding.id.startsWith('density-')) return 'density';
  if (finding.id.startsWith('light-')) return 'light';
  if (finding.id.startsWith('seating-')) return 'seating';
  if (finding.id.startsWith('missing-role-')) return 'missing-role';
  if (finding.id.startsWith('unplaced-key-')) return 'unplaced-key';
  return null;
}

export function extractRepairConflicts(artifacts: Artifact[], zones: Zone[]): RepairConflict[] {
  const { findings } = analyzeJourney(artifacts, zones);
  const conflicts: RepairConflict[] = [];
  for (const finding of findings) {
    if (finding.type === 'notice') continue;
    const kind = parseFindingKind(finding);
    if (!kind) continue;
    conflicts.push({
      id: finding.id,
      kind,
      severity: finding.type === 'error' ? 'error' : 'warning',
      title: finding.title,
      detail: finding.detail,
      zoneId: finding.zoneId,
      artifactId: finding.artifactId,
      role: kind === 'missing-role' ? (finding.id.replace('missing-role-', '') as Artifact['narrativeRole']) : undefined,
    });
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// Working-state simulation (pure; never touches the real plan)
// ---------------------------------------------------------------------------

interface WorkingState {
  artifacts: Artifact[];
  zones: Zone[];
}

function applyOperation(state: WorkingState, operation: RepairOperation): WorkingState {
  const zones = state.zones.map((zone) => ({ ...zone, artifactIds: zone.artifactIds.filter((id) => id !== operation.artifactId) }));
  if ((operation.kind === 'move' || operation.kind === 'place') && operation.zoneId) {
    const target = zones.find((zone) => zone.id === operation.zoneId);
    if (target) target.artifactIds.push(operation.artifactId);
  }
  return { artifacts: state.artifacts, zones };
}

function zoneOfArtifact(state: WorkingState, artifactId: string): Zone | undefined {
  return state.zones.find((zone) => zone.artifactIds.includes(artifactId));
}

function dwellIn(zone: Zone, artifacts: Artifact[], excludeId?: string): number {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  return zone.artifactIds
    .filter((id) => id !== excludeId)
    .reduce((total, id) => total + (byId.get(id)?.dwellMinutes ?? 0), 0);
}

// ---------------------------------------------------------------------------
// Candidate generation
// ---------------------------------------------------------------------------

interface ScoredCandidate {
  operation: RepairOperation;
  /** Lower rank tuples are preferred; compared lexicographically. */
  cost: number[];
  resolves: Set<string>;
  newWarningIds: string[];
  newErrorIds: string[];
  blocked?: BlockedCondition;
}

/** Static compatibility and capacity check used both for candidates and commits. */
export function evaluateZoneForArtifact(zone: Zone, artifact: Artifact, state: WorkingState): BlockedCondition | null {
  if (artifact.sensitivity === 'low-light' && !zone.lowLight) {
    return {
      code: 'no-light-compatible-zone',
      zoneId: zone.id,
      artifactId: artifact.id,
      message: `${zone.name} is not a low-light zone; ${artifact.title} requires controlled light.`,
    };
  }
  if (artifact.accessibilityNeed === 'seating' && !zone.hasSeating) {
    return {
      code: 'no-seating-zone',
      zoneId: zone.id,
      artifactId: artifact.id,
      message: `${zone.name} has no seating; ${artifact.title} needs seated interpretation.`,
    };
  }
  const incomingDwell = dwellIn(zone, state.artifacts, artifact.id);
  if (zone.artifactIds.filter((id) => id !== artifact.id).length + 1 > zone.maxObjects) {
    return {
      code: 'every-zone-full',
      zoneId: zone.id,
      artifactId: artifact.id,
      message: `${zone.name} already holds its limit of ${zone.maxObjects} objects.`,
    };
  }
  if (incomingDwell + artifact.dwellMinutes > zone.capacityMinutes) {
    return {
      code: 'would-overload-target',
      zoneId: zone.id,
      artifactId: artifact.id,
      message: `Moving ${artifact.title} would push ${zone.name} over its ${zone.capacityMinutes}-minute dwell capacity.`,
    };
  }
  return null;
}

function isLastRoleCarrier(state: WorkingState, artifact: Artifact): boolean {
  const placedRoleCount = state.zones
    .flatMap((zone) => zone.artifactIds)
    .filter((id) => state.artifacts.find((candidate) => candidate.id === id)?.narrativeRole === artifact.narrativeRole).length;
  return placedRoleCount <= 1;
}

function scoreCandidate(
  state: WorkingState,
  conflict: RepairConflict,
  operation: RepairOperation,
  selectedIds: Set<string>,
): ScoredCandidate {
  const simulated = applyOperation(state, operation);
  const beforeAnalysis = analyzeJourney(state.artifacts, state.zones);
  const beforeIds = new Set(beforeAnalysis.findings.map((finding) => finding.id));
  const afterAnalysis = analyzeJourney(simulated.artifacts, simulated.zones);
  const newErrorFindings = afterAnalysis.findings.filter((finding) => finding.type === 'error' && !beforeIds.has(finding.id));
  const newWarningIds = afterAnalysis.findings
    .filter((finding) => finding.type === 'warning' && !beforeIds.has(finding.id))
    .map((finding) => finding.id);
  const newErrorIds = newErrorFindings.map((finding) => finding.id);
  const afterIds = new Set(afterAnalysis.findings.map((finding) => finding.id));
  const resolves = new Set([...selectedIds].filter((id) => !afterIds.has(id)));

  // A candidate that trades the selected conflict for a fresh blocking error is
  // never viable, regardless of how well it resolves the targeted conflict.
  if (newErrorIds.length > 0) {
    const names = newErrorFindings.map((finding) => finding.title).join('; ');
    return {
      operation,
      cost: [9, 0, 0, 0, 0],
      resolves,
      newWarningIds,
      newErrorIds,
      blocked: {
        code: 'would-create-conflict',
        artifactId: operation.artifactId,
        zoneId: operation.zoneId,
        message: `This move introduces a blocking constraint: ${names}.`,
      },
    };
  }

  const fromZone = zoneOfArtifact(state, operation.artifactId);
  const objectIndex = fromZone ? fromZone.artifactIds.indexOf(operation.artifactId) : 0;
  const targetZone = simulated.zones.find((zone) => zone.artifactIds.includes(operation.artifactId));
  const targetSequence = targetZone?.sequence ?? 99;
  const kindRank = operation.kind === 'unplace' ? 1 : 0;

  // Deterministic ordering:
  // 1. must resolve the conflict it was generated for
  // 2. never trade the selected conflict for a fresh warning elsewhere
  // 3. resolve as many of the selected conflicts as possible
  // 4. prefer moves/places over returning objects to the queue
  // 5. prefer earlier objects in their zone, then earlier destination zones
  const cost = [
    resolves.has(conflict.id) ? 0 : 1,
    newWarningIds.length,
    -resolves.size,
    kindRank,
    objectIndex,
    targetSequence,
  ];
  return { operation, cost, resolves, newWarningIds, newErrorIds };
}

/** Every viable move/unplace candidate for a placed object, plus blocked reasons. */
function placedObjectCandidates(
  state: WorkingState,
  conflict: RepairConflict,
  artifact: Artifact,
  selectedIds: Set<string>,
): ScoredCandidate[] {
  const origin = zoneOfArtifact(state, artifact.id);
  if (artifact.isKeyObject) {
    return [{
      operation: { kind: 'move', artifactId: artifact.id },
      cost: [9, 0, 0, 0, 0],
      resolves: new Set(),
      newWarningIds: [], newErrorIds: [],
      blocked: {
        code: 'key-object-protected',
        artifactId: artifact.id,
        message: `${artifact.title} is a key object; automatic proposals never move it. Move it manually if the team agrees.`,
      },
    }];
  }
  const candidates: ScoredCandidate[] = [];
  const targets = state.zones.filter((zone) => zone.id !== origin?.id).sort((a, b) => a.sequence - b.sequence);
  for (const target of targets) {
    const blocked = evaluateZoneForArtifact(target, artifact, state);
    if (blocked) {
      candidates.push({
        operation: { kind: 'move', artifactId: artifact.id, zoneId: target.id },
        cost: [9, 0, 0, 0, 0],
        resolves: new Set(),
        newWarningIds: [], newErrorIds: [],
        blocked,
      });
    } else {
      candidates.push(scoreCandidate(state, conflict, { kind: 'move', artifactId: artifact.id, zoneId: target.id }, selectedIds));
    }
  }
  if (isLastRoleCarrier(state, artifact)) {
    candidates.push({
      operation: { kind: 'unplace', artifactId: artifact.id },
      cost: [9, 0, 0, 0, 0],
      resolves: new Set(),
      newWarningIds: [], newErrorIds: [],
      blocked: {
        code: 'last-role-carrier',
        artifactId: artifact.id,
        message: `${artifact.title} is the only placed ${artifact.narrativeRole.replace('-', ' ')} object; returning it to the queue would break the story arc.`,
      },
    });
  } else {
    candidates.push(scoreCandidate(state, conflict, { kind: 'unplace', artifactId: artifact.id }, selectedIds));
  }
  return candidates;
}

function queueCandidates(
  state: WorkingState,
  conflict: RepairConflict,
  artifact: Artifact,
  selectedIds: Set<string>,
): ScoredCandidate[] {
  const targets = state.zones
    .filter((zone) => evaluateZoneForArtifact(zone, artifact, state) === null)
    .sort((a, b) => a.sequence - b.sequence);
  if (targets.length === 0) {
    const firstZone = state.zones.slice().sort((a, b) => a.sequence - b.sequence)[0];
    const blocked: BlockedCondition = firstZone
      ? (evaluateZoneForArtifact(firstZone, artifact, state) ?? {
          code: 'would-overload-target',
          artifactId: artifact.id,
          message: `No zone can currently accept ${artifact.title}.`,
        })
      : {
          code: 'no-candidate-object',
          artifactId: artifact.id,
          message: `No destination zone is available for ${artifact.title}.`,
        };
    return [{ operation: { kind: 'place', artifactId: artifact.id }, cost: [9, 0, 0, 0, 0], resolves: new Set(), newWarningIds: [], newErrorIds: [], blocked }];
  }
  return targets.map((target) => scoreCandidate(state, conflict, { kind: 'place', artifactId: artifact.id, zoneId: target.id }, selectedIds));
}

function candidatesForConflict(state: WorkingState, conflict: RepairConflict, selectedIds: Set<string>): ScoredCandidate[] {
  const byId = new Map(state.artifacts.map((artifact) => [artifact.id, artifact]));
  if (conflict.kind === 'capacity' || conflict.kind === 'density') {
    const zone = state.zones.find((candidate) => candidate.id === conflict.zoneId);
    if (!zone) return [];
    return zone.artifactIds.flatMap((id) => {
      const artifact = byId.get(id);
      return artifact ? placedObjectCandidates(state, conflict, artifact, selectedIds) : [];
    });
  }
  if (conflict.kind === 'light' || conflict.kind === 'seating') {
    const artifact = conflict.artifactId ? byId.get(conflict.artifactId) : undefined;
    return artifact ? placedObjectCandidates(state, conflict, artifact, selectedIds) : [];
  }
  if (conflict.kind === 'unplaced-key') {
    const artifact = conflict.artifactId ? byId.get(conflict.artifactId) : undefined;
    return artifact ? queueCandidates(state, conflict, artifact, selectedIds) : [];
  }
  // Missing role: the fix must come from an unplaced object carrying that role.
  const role = conflict.role;
  const placedIds = new Set(state.zones.flatMap((zone) => zone.artifactIds));
  const queue = state.artifacts
    .filter((artifact) => !placedIds.has(artifact.id) && artifact.narrativeRole === role)
    .sort((a, b) => a.title.localeCompare(b.title));
  if (queue.length === 0) {
    return [{
      operation: { kind: 'place', artifactId: '' },
      cost: [9, 0, 0, 0, 0],
      resolves: new Set(),
      newWarningIds: [], newErrorIds: [],
      blocked: {
        code: 'no-candidate-object',
        message: `No ${role?.replace('-', ' ')} object exists in the collection; add one or change an object's narrative role.`,
      },
    }];
  }
  return queue.flatMap((artifact) => queueCandidates(state, conflict, artifact, selectedIds));
}

// ---------------------------------------------------------------------------
// Proposal construction (deterministic greedy minimal set)
// ---------------------------------------------------------------------------

const MAX_SANDBOX_STEPS = 24;

function compareCost(a: ScoredCandidate, b: ScoredCandidate): number {
  const length = Math.max(a.cost.length, b.cost.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a.cost[i] ?? 0) - (b.cost[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return JSON.stringify(a.operation).localeCompare(JSON.stringify(b.operation));
}

function sameOperation(a: RepairOperation, b: RepairOperation): boolean {
  return a.kind === b.kind && a.artifactId === b.artifactId && (a.zoneId ?? '') === (b.zoneId ?? '');
}

export interface BuildProposalInput {
  state: WorkspaceState;
  selectedConflictIds: string[];
  revision?: PlanRevision;
}

interface ChosenStep {
  candidate: ScoredCandidate;
  conflict: RepairConflict;
  workingAfter: WorkingState;
}

export function buildRepairProposal({ state, selectedConflictIds, revision }: BuildProposalInput): RepairProposal {
  const available = extractRepairConflicts(state.artifacts, state.zones);
  const selected = available.filter((conflict) => selectedConflictIds.includes(conflict.id));
  const selectedIds = new Set(selected.map((conflict) => conflict.id));
  let working: WorkingState = { artifacts: state.artifacts, zones: state.zones };

  const chosen: ChosenStep[] = [];
  const cautionIds = new Set<string>();
  let unresolved: RepairConflict[] = [];

  for (let step = 0; step < MAX_SANDBOX_STEPS; step += 1) {
    const currentIds = new Set(analyzeJourney(working.artifacts, working.zones).findings.map((finding) => finding.id));
    const remaining = selected.filter((conflict) => currentIds.has(conflict.id));
    if (remaining.length === 0) break;
    const pool: ScoredCandidate[] = [];
    for (const conflict of remaining) {
      pool.push(...candidatesForConflict(working, conflict, selectedIds));
    }
    const viable = pool
      // Static incompatibility (light, seating, capacity, key-object, …)
      .filter((candidate) => !candidate.blocked)
      // Structural guarantee: a single step may not introduce a fresh blocking
      // error anywhere (even while resolving the conflict it was scored for).
      .filter((candidate) => candidate.newErrorIds.length === 0)
      .filter((candidate) => !chosen.some((entry) => sameOperation(entry.candidate.operation, candidate.operation)))
      .sort(compareCost);
    const winner = viable[0];
    if (!winner) {
      unresolved = remaining;
      break;
    }
    const conflict = remaining.find((entry) => winner.resolves.has(entry.id)) ?? remaining[0];
    for (const warningId of winner.newWarningIds) cautionIds.add(warningId);
    working = applyOperation(working, winner.operation);
    chosen.push({ candidate: winner, conflict, workingAfter: working });
  }

  // Final verification: replay the chosen steps against the original plan.
  // Every selected conflict must be gone and no step may introduce a fresh
  // blocking error. The first offending step invalidates itself and everything
  // after it, so a proposal can never contain a blocking change.
  const initialAnalysis = analyzeJourney(state.artifacts, state.zones);
  const initialIds = new Set(initialAnalysis.findings.map((finding) => finding.id));
  const initialErrorIds = new Set(initialAnalysis.findings.filter((finding) => finding.type === 'error').map((finding) => finding.id));
  let replay: WorkingState = { artifacts: state.artifacts, zones: state.zones };
  const safeSteps: ChosenStep[] = [];
  for (const step of chosen) {
    const next = applyOperation(replay, step.candidate.operation);
    const nextAnalysis = analyzeJourney(next.artifacts, next.zones);
    const introducesError = nextAnalysis.findings.some(
      (finding) => finding.type === 'error' && !initialErrorIds.has(finding.id),
    );
    if (introducesError) {
      // This step (and any later one) cannot be part of the proposal.
      const stillSelected = new Set(analyzeJourney(replay.artifacts, replay.zones).findings.map((finding) => finding.id));
      for (const conflict of selected) {
        if (stillSelected.has(conflict.id) && !unresolved.some((entry) => entry.id === conflict.id)) {
          unresolved.push(conflict);
        }
      }
      break;
    }
    replay = next;
    safeSteps.push(step);
  }

  const finalAnalysis = analyzeJourney(replay.artifacts, replay.zones);
  const finalIds = new Set(finalAnalysis.findings.map((finding) => finding.id));
  for (const conflictId of selectedIds) {
    if (finalIds.has(conflictId) && !unresolved.some((conflict) => conflict.id === conflictId)) {
      const conflict = selected.find((candidate) => candidate.id === conflictId);
      if (conflict) unresolved.push(conflict);
    }
  }
  const newErrors = finalAnalysis.findings.filter((finding) => finding.type === 'error' && !initialIds.has(finding.id));
  for (const finding of finalAnalysis.findings.filter((item) => item.type === 'warning' && !initialIds.has(item.id))) {
    cautionIds.add(finding.id);
  }
  const cautions: RepairCaution[] = finalAnalysis.findings
    .filter((finding) => cautionIds.has(finding.id))
    .map((finding) => ({ id: finding.id, title: finding.title, detail: finding.detail }));

  const changes: RepairChange[] = safeSteps.map((entry, index) =>
    describeChange(state, entry, selectedIds, index + 1),
  );

  // Unavailable options are reported only for conflicts the plan could not fix,
  // and always explained against the plan the user is looking at.
  const blockedOptions: RepairBlockedOption[] = [];
  const seenBlocked = new Set<string>();
  const original: WorkingState = { artifacts: state.artifacts, zones: state.zones };
  for (const conflict of unresolved) {
    for (const candidate of candidatesForConflict(original, conflict, selectedIds)) {
      if (!candidate.blocked) continue;
      const dedupeKey = `${conflict.id}:${JSON.stringify(candidate.operation)}`;
      if (seenBlocked.has(dedupeKey)) continue;
      seenBlocked.add(dedupeKey);
      const artifactTitle = candidate.operation.artifactId
        ? state.artifacts.find((artifact) => artifact.id === candidate.operation.artifactId)?.title
        : undefined;
      blockedOptions.push({ conflictId: conflict.id, operation: candidate.operation, artifactTitle, blocked: candidate.blocked });
    }
  }

  return {
    revision: revision ?? computePlanRevision(state),
    conflicts: selected,
    changes,
    blockedOptions,
    unresolvedConflictIds: [...new Set(unresolved.map((conflict) => conflict.id))],
    cautions,
    complete: unresolved.length === 0 && newErrors.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Human-readable change descriptions
// ---------------------------------------------------------------------------

function conflictReason(conflict: RepairConflict, artifactTitle: string): string {
  switch (conflict.kind) {
    case 'capacity':
      return `The zone is over its dwell budget; relocating ${artifactTitle} frees its time without editing the zone.`;
    case 'density':
      return `The zone holds too many objects; relocating ${artifactTitle} restores spacing.`;
    case 'light':
      return `${artifactTitle} needs a low-light zone and the current zone is not configured for it.`;
    case 'seating':
      return `${artifactTitle} needs seated interpretation and the current zone has no seating.`;
    case 'unplaced-key':
      return `${artifactTitle} is a key object missing from the visitor journey.`;
    case 'missing-role':
      return `The journey has no placed ${(conflict.role ?? '').replace('-', ' ')} object, so the story arc is incomplete.`;
    default:
      return conflict.detail;
  }
}

function describeChange(
  originalState: WorkspaceState,
  step: ChosenStep,
  selectedIds: Set<string>,
  order: number,
): RepairChange {
  const { operation } = step.candidate;
  const artifact = originalState.artifacts.find((item) => item.id === operation.artifactId);
  const artifactTitle = artifact?.title ?? 'Object';
  const origin = originalState.zones.find((zone) => zone.artifactIds.includes(operation.artifactId));
  const destinationName = operation.zoneId
    ? originalState.zones.find((zone) => zone.id === operation.zoneId)?.name
    : undefined;

  let summary: string;
  if (operation.kind === 'move') {
    summary = `Move ${artifactTitle} from ${origin?.name ?? 'the queue'} to ${destinationName}`;
  } else if (operation.kind === 'place') {
    summary = `Place ${artifactTitle} in ${destinationName}`;
  } else {
    summary = `Return ${artifactTitle} from ${origin?.name ?? 'a zone'} to the object queue`;
  }

  return {
    id: `repair-change-${order}-${operation.kind}-${operation.artifactId}-${operation.zoneId ?? 'queue'}`,
    operation,
    artifactTitle,
    fromZoneName: origin?.name,
    toZoneName: destinationName,
    summary,
    reason: conflictReason(step.conflict, artifactTitle),
    resolvesConflictIds: [...step.candidate.resolves].filter((id) => selectedIds.has(id)),
    affectedMaterials: collectAffectedMaterials(originalState, operation, artifactTitle),
  };
}

function collectAffectedMaterials(
  state: WorkspaceState,
  operation: RepairOperation,
  artifactTitle: string,
): AffectedMaterial[] {
  const materials: AffectedMaterial[] = [];
  const origin = state.zones.find((zone) => zone.artifactIds.includes(operation.artifactId));
  const destination = operation.zoneId ? state.zones.find((zone) => zone.id === operation.zoneId) : undefined;

  if (origin) {
    materials.push({
      type: 'zone',
      id: origin.id,
      label: origin.name,
      detail: operation.kind === 'move'
        ? `Visit order and dwell total change when ${artifactTitle} leaves.`
        : `Zone loses ${artifactTitle} from its visit order.`,
    });
  }
  if (destination) {
    materials.push({
      type: 'zone',
      id: destination.id,
      label: destination.name,
      detail: `${artifactTitle} is appended to the end of this zone's visit order; the dwell total rises.`,
    });
  }
  materials.push({
    type: 'artifact',
    id: operation.artifactId,
    label: artifactTitle,
    detail: operation.kind === 'unplace'
      ? 'Returned to the unplaced queue; no object record is deleted.'
      : 'Placement history changes; the object record itself is untouched.',
  });

  const linkedIssues = state.issues.filter(
    (issue: ReviewIssue) =>
      issue.artifactId === operation.artifactId
      || (Boolean(origin) && issue.zoneId === origin?.id)
      || (Boolean(destination) && issue.zoneId === destination?.id),
  );
  for (const issue of linkedIssues) {
    materials.push({
      type: 'finding',
      id: issue.id,
      label: issue.title,
      detail: `Review finding (${issue.severity}, ${issue.status}) is linked to this object or one of the zones.`,
    });
  }
  if (state.project.lastReadinessCheck) {
    materials.push({
      type: 'readiness',
      label: 'Readiness check',
      detail: 'The last readiness result is superseded and must be re-run after applying this change.',
    });
  }
  return materials;
}

// ---------------------------------------------------------------------------
// Atomic commit
// ---------------------------------------------------------------------------

export type RepairCommitErrorCode = 'stale-revision' | 'already-applied' | 'no-changes' | 'simulation-failed';

export class RepairCommitError extends Error {
  constructor(public readonly code: RepairCommitErrorCode, message: string) {
    super(message);
    this.name = 'RepairCommitError';
  }
}

export interface CommitRepairInput {
  state: WorkspaceState;
  operations: RepairOperation[];
  expectedRevision: PlanRevision;
  /**
   * Signature of the exact proposal already confirmed in this session
   * (revision + ordered operations). Only an identical confirmation is
   * rejected; a fresh proposal that merely targets the same current revision
   * (e.g. the remaining conflicts after a successful repair) is allowed.
   */
  appliedSignature?: string | null;
}

export function repairCommitSignature(operations: RepairOperation[], expectedRevision: PlanRevision): string {
  return `${expectedRevision}:${JSON.stringify(operations.map((operation) => [operation.kind, operation.artifactId, operation.zoneId ?? null]))}`;
}

export function commitRepairOperations({ state, operations, expectedRevision, appliedSignature }: CommitRepairInput): WorkspaceState {
  const currentRevision = computePlanRevision(state);
  const signature = repairCommitSignature(operations, expectedRevision);
  if (appliedSignature && appliedSignature === signature) {
    throw new RepairCommitError('already-applied', 'This repair proposal was already applied.');
  }
  if (currentRevision !== expectedRevision) {
    throw new RepairCommitError(
      'stale-revision',
      'A placement or finding changed while the proposal was open; the candidate set has been recalculated.',
    );
  }
  if (operations.length === 0) {
    throw new RepairCommitError('no-changes', 'There are no changes to apply.');
  }

  // Dry-run against exactly the revision being committed.
  let working: WorkingState = { artifacts: state.artifacts, zones: state.zones };
  for (const operation of operations) {
    const artifact = state.artifacts.find((candidate) => candidate.id === operation.artifactId);
    if (!artifact) throw new RepairCommitError('simulation-failed', `Object ${operation.artifactId} no longer exists.`);
    if (artifact.isKeyObject && operation.kind !== 'place') {
      throw new RepairCommitError('simulation-failed', `Key object ${artifact.title} cannot be moved or unplaced automatically.`);
    }
    const currentlyPlaced = working.zones.some((zone) => zone.artifactIds.includes(operation.artifactId));
    if (operation.kind === 'unplace' || operation.kind === 'move') {
      if (!currentlyPlaced) throw new RepairCommitError('simulation-failed', `${artifact.title} is no longer in the expected zone.`);
    }
    if (operation.kind === 'place') {
      if (currentlyPlaced) throw new RepairCommitError('simulation-failed', `${artifact.title} is already placed somewhere.`);
    }
    if (operation.kind !== 'unplace') {
      const target = state.zones.find((zone) => zone.id === operation.zoneId);
      if (!target) throw new RepairCommitError('simulation-failed', 'A target zone no longer exists.');
      const blocked = evaluateZoneForArtifact(target, artifact, working);
      if (blocked) throw new RepairCommitError('simulation-failed', blocked.message);
    }
    working = applyOperation(working, operation);
  }
  const simulation = analyzeJourney(working.artifacts, working.zones);
  if (simulation.blockingCount > 0) {
    throw new RepairCommitError('simulation-failed', 'Applying this proposal would still leave blocking constraints.');
  }

  // Commit everything at once.
  return { ...state, zones: working.zones };
}
