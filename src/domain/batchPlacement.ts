import { createId } from './ids';
import type { Artifact, NarrativeRole, WorkspaceState, Zone } from './models';

const ALL_ROLES: NarrativeRole[] = ['threshold', 'context', 'turning-point', 'reflection'];

export interface PlacementCandidate {
  artifactId: string;
  zoneId: string;
  index?: number;
}

export interface BatchPlacementPlan {
  transactionId: string;
  baseFingerprint: string;
  candidates: PlacementCandidate[];
}

export type CandidateVerdict = 'ready' | 'tradeoff' | 'blocked' | 'already-placed';

export interface CandidateAssessment {
  candidate: PlacementCandidate;
  artifact?: Artifact;
  zone?: Zone;
  verdict: CandidateVerdict;
  reasons: string[];
}

export interface ZoneBatchSummary {
  zoneId: string;
  zoneName: string;
  resultingObjects: number;
  maxObjects: number;
  resultingMinutes: number;
  capacityMinutes: number;
  overObjectLimit: boolean;
  overCapacity: boolean;
  nearingCapacity: boolean;
}

export interface BatchPlacementEvaluation {
  transactionId: string;
  baseFingerprint: string;
  currentFingerprint: string;
  stale: boolean;
  alreadyApplied: boolean;
  assessments: CandidateAssessment[];
  readyCount: number;
  tradeoffCount: number;
  blockedCount: number;
  zoneSummaries: ZoneBatchSummary[];
  roleGaps: NarrativeRole[];
  keyObjectGaps: string[];
  canApply: boolean;
}

/**
 * Fingerprint of everything a batch placement depends on: which artifacts
 * exist and where each one is placed. Any placement, removal, or collection
 * change produces a different fingerprint, so a staged batch can detect
 * concurrent changes before it is applied.
 */
export function placementFingerprint(state: WorkspaceState): string {
  const zonePart = state.zones
    .map((zone) => `${zone.id}=${zone.artifactIds.join(',')}`)
    .sort()
    .join('|');
  const artifactPart = state.artifacts.map((artifact) => artifact.id).sort().join(',');
  return `${zonePart}#${artifactPart}`;
}

export function stageBatchPlacement(
  state: WorkspaceState,
  candidates: PlacementCandidate[],
  transactionId: string = createId('batch'),
): BatchPlacementPlan {
  return { transactionId, baseFingerprint: placementFingerprint(state), candidates };
}

/**
 * Applies every candidate to the workspace zones in array order. Each
 * candidate first removes its artifact from any zone, then inserts it at the
 * requested position (appended when no index is given), which makes a replay
 * of the same candidate list a no-op. Unknown artifacts or zones throw so a
 * batch can never half-apply silently.
 */
export function applyPlacementCandidates(state: WorkspaceState, candidates: PlacementCandidate[]): WorkspaceState {
  let zones = state.zones;
  for (const candidate of candidates) {
    if (!state.artifacts.some((artifact) => artifact.id === candidate.artifactId)) {
      throw new Error('Cannot place an artifact that is not in the collection.');
    }
    if (!zones.some((zone) => zone.id === candidate.zoneId)) {
      throw new Error('Cannot place an artifact in an unknown zone.');
    }
    zones = zones.map((zone) => ({ ...zone, artifactIds: zone.artifactIds.filter((id) => id !== candidate.artifactId) }));
    zones = zones.map((zone) => {
      if (zone.id !== candidate.zoneId) return zone;
      const targetIndex = candidate.index === undefined
        ? zone.artifactIds.length
        : Math.max(0, Math.min(candidate.index, zone.artifactIds.length));
      const artifactIds = [...zone.artifactIds];
      artifactIds.splice(targetIndex, 0, candidate.artifactId);
      return { ...zone, artifactIds };
    });
  }
  return { ...state, zones };
}

function summarizeZones(state: WorkspaceState, zones: Zone[]): ZoneBatchSummary[] {
  const artifactById = new Map(state.artifacts.map((artifact) => [artifact.id, artifact]));
  return zones.map((zone) => {
    const placed = zone.artifactIds
      .map((id) => artifactById.get(id))
      .filter((artifact): artifact is Artifact => Boolean(artifact));
    const resultingMinutes = placed.reduce((total, artifact) => total + artifact.dwellMinutes, 0);
    const utilization = zone.capacityMinutes ? resultingMinutes / zone.capacityMinutes : 0;
    return {
      zoneId: zone.id,
      zoneName: zone.name,
      resultingObjects: placed.length,
      maxObjects: zone.maxObjects,
      resultingMinutes,
      capacityMinutes: zone.capacityMinutes,
      overObjectLimit: placed.length > zone.maxObjects,
      overCapacity: resultingMinutes > zone.capacityMinutes,
      nearingCapacity: utilization >= 0.8 && utilization <= 1,
    };
  });
}

/**
 * Evaluates a staged batch against the current workspace without mutating
 * anything. The result separates candidates that cannot be satisfied
 * (blocked) from trade-offs that need a human decision (warnings, moves),
 * and projects role coverage, key-object coverage, and zone load as if the
 * whole batch were applied.
 */
export function evaluateBatchPlacement(state: WorkspaceState, plan: BatchPlacementPlan): BatchPlacementEvaluation {
  const currentFingerprint = placementFingerprint(state);
  const stale = currentFingerprint !== plan.baseFingerprint;
  const artifactById = new Map(state.artifacts.map((artifact) => [artifact.id, artifact]));
  const zoneById = new Map(state.zones.map((zone) => [zone.id, zone]));
  const candidateCounts = new Map<string, number>();
  for (const candidate of plan.candidates) {
    candidateCounts.set(candidate.artifactId, (candidateCounts.get(candidate.artifactId) ?? 0) + 1);
  }

  const assessments: CandidateAssessment[] = plan.candidates.map((candidate) => {
    const artifact = artifactById.get(candidate.artifactId);
    const zone = zoneById.get(candidate.zoneId);
    const reasons: string[] = [];
    let verdict: CandidateVerdict = 'ready';

    if (!artifact) {
      verdict = 'blocked';
      reasons.push('This object is no longer in the collection.');
    }
    if (!zone) {
      verdict = 'blocked';
      reasons.push('The target zone no longer exists.');
    }
    if (artifact && zone) {
      if ((candidateCounts.get(candidate.artifactId) ?? 0) > 1) {
        verdict = 'blocked';
        reasons.push(`${artifact.title} appears more than once in this batch.`);
      } else {
        const currentZone = state.zones.find((placed) => placed.artifactIds.includes(artifact.id));
        if (currentZone && currentZone.id === zone.id) {
          verdict = 'already-placed';
          reasons.push(`Already placed in ${zone.name}; nothing to do.`);
        } else {
          if (currentZone) {
            verdict = 'tradeoff';
            reasons.push(`Moves the object out of ${currentZone.name}.`);
          }
          if (artifact.sensitivity === 'low-light' && !zone.lowLight) {
            verdict = 'blocked';
            reasons.push(`${artifact.title} requires a low-light zone.`);
          }
          if (artifact.accessibilityNeed === 'seating' && !zone.hasSeating) {
            if (verdict === 'ready') verdict = 'tradeoff';
            reasons.push(`${artifact.title} benefits from seated interpretation, which ${zone.name} lacks.`);
          }
        }
      }
    }
    return { candidate, artifact, zone, verdict, reasons };
  });

  const applicable = assessments
    .filter((assessment) => assessment.verdict !== 'blocked')
    .map((assessment) => assessment.candidate);
  const simulated = applyPlacementCandidates(state, applicable);
  const zoneSummaries = summarizeZones(state, simulated.zones);

  for (const assessment of assessments) {
    if (assessment.verdict === 'blocked' || assessment.verdict === 'already-placed') continue;
    const summary = zoneSummaries.find((candidate) => candidate.zoneId === assessment.candidate.zoneId);
    if (!summary) continue;
    if (summary.overObjectLimit) {
      assessment.verdict = 'blocked';
      assessment.reasons.push(`${summary.zoneName} would hold ${summary.resultingObjects} objects against a limit of ${summary.maxObjects}.`);
    } else if (summary.overCapacity) {
      assessment.verdict = 'blocked';
      assessment.reasons.push(`${summary.zoneName} would exceed its dwell capacity (${summary.resultingMinutes} of ${summary.capacityMinutes} min).`);
    } else if (summary.nearingCapacity) {
      if (assessment.verdict === 'ready') assessment.verdict = 'tradeoff';
      const percent = Math.round((summary.resultingMinutes / summary.capacityMinutes) * 100);
      assessment.reasons.push(`${summary.zoneName} would reach ${percent}% of its dwell capacity.`);
    }
  }

  const placedIds = new Set(simulated.zones.flatMap((zone) => zone.artifactIds));
  const placedRoles = new Set(
    state.artifacts.filter((artifact) => placedIds.has(artifact.id)).map((artifact) => artifact.narrativeRole),
  );
  const roleGaps = ALL_ROLES.filter((role) => !placedRoles.has(role));
  const keyObjectGaps = state.artifacts
    .filter((artifact) => artifact.isKeyObject && !placedIds.has(artifact.id))
    .map((artifact) => artifact.id);

  const readyCount = assessments.filter((assessment) => assessment.verdict === 'ready').length;
  const tradeoffCount = assessments.filter((assessment) => assessment.verdict === 'tradeoff').length;
  const blockedCount = assessments.filter((assessment) => assessment.verdict === 'blocked').length;
  const alreadyApplied = assessments.length > 0 && assessments.every((assessment) => assessment.verdict === 'already-placed');

  return {
    transactionId: plan.transactionId,
    baseFingerprint: plan.baseFingerprint,
    currentFingerprint,
    stale,
    alreadyApplied,
    assessments,
    readyCount,
    tradeoffCount,
    blockedCount,
    zoneSummaries,
    roleGaps,
    keyObjectGaps,
    canApply: assessments.length > 0 && blockedCount === 0 && !stale && !alreadyApplied,
  };
}
