import { analyzeJourney } from './journeyAnalysis';
import { clampScenario, projectScenario } from './scenario';
import { regressReadyProject } from './transitions';
import type {
  Artifact,
  JourneyAnalysis,
  PlanningPreferences,
  ScenarioInput,
  WorkspaceState,
  Zone,
} from './models';

// ---------------------------------------------------------------------------
// Planning transactions turn projection advice into a reviewable, atomically
// applicable set of plan changes. A batch is prepared against a plan revision;
// submitting it validates every change against the live state first, so a
// version conflict, invalid object, or capacity breach rejects the whole batch.
// ---------------------------------------------------------------------------

export type PlanChangeKind = 'preferences' | 'artifact-dwell' | 'zone-seating' | 'artifact-move';

export interface PreferencesChange {
  kind: 'preferences';
  preferences: PlanningPreferences;
}

export interface ArtifactDwellChange {
  kind: 'artifact-dwell';
  artifactId: string;
  dwellMinutes: number;
  reason: string;
}

export interface ZoneSeatingChange {
  kind: 'zone-seating';
  zoneId: string;
  hasSeating: boolean;
}

export interface ArtifactMoveChange {
  kind: 'artifact-move';
  artifactId: string;
  fromZoneId: string;
  toZoneId: string;
  index: number;
}

export type PlanChange = PreferencesChange | ArtifactDwellChange | ZoneSeatingChange | ArtifactMoveChange;

export interface PlanSuggestion {
  id: string;
  title: string;
  detail: string;
  category: 'visit-preferences' | 'object-dwell' | 'zone-pressure' | 'access';
  changes: PlanChange[];
  /** Suggestion ids that must also be selected before this one can apply. */
  requires: string[];
}

// ---------------------------------------------------------------------------
// Fact preview: each change declares the saved plan fact it expects to find
// when the batch is committed. A mismatch means the plan changed underneath
// the prepared batch.
// ---------------------------------------------------------------------------

export interface PlanFactExpectation {
  key: string;
  label: string;
  before: string;
  after: string;
}

export type PlanIssueCode =
  | 'version-conflict'
  | 'unknown-suggestion'
  | 'invalid-object'
  | 'invalid-zone'
  | 'fact-mismatch'
  | 'missing-dependency'
  | 'fact-conflict'
  | 'capacity-exceeded'
  | 'predicted-warning';

export interface PlanBatchIssue {
  code: PlanIssueCode;
  blocking: boolean;
  message: string;
  suggestionId?: string;
  zoneId?: string;
  artifactId?: string;
}

export interface PlanFactDelta extends PlanFactExpectation {
  suggestionIds: string[];
}

export interface PlanPrediction {
  durationMinutes: number;
  comfortScore: number;
  accessibilityScore: number;
  narrativeScore: number;
  pressureZoneIds: string[];
  blockingJourneyCount: number;
  warningJourneyCount: number;
  deltas: {
    durationMinutes: number;
    comfortScore: number;
    accessibilityScore: number;
    narrativeScore: number;
  };
}

export interface PlanBatchPreview {
  suggestionIds: string[];
  baseRevision: number;
  scenarioInput: ScenarioInput;
  suggestions: PlanSuggestion[];
  factDeltas: PlanFactDelta[];
  dependencies: Array<{ suggestionId: string; requiresId: string; satisfied: boolean }>;
  issues: PlanBatchIssue[];
  prediction: PlanPrediction;
  canCommit: boolean;
}

export interface PlanTransaction {
  id: string;
  suggestionIds: string[];
  baseRevision: number;
  committedRevision: number;
  changes: PlanChange[];
  /**
   * Inverse changes captured against the pre-commit state. Reverting applies
   * these to the live state, so each fact is restored to exactly what it was
   * immediately before the transaction.
   */
  inverseChanges: PlanChange[];
  /** Snapshot of the affected collections before commit, used as the revert capacity baseline. */
  baseArtifacts: Artifact[];
  baseZones: Zone[];
  summary: string;
  appliedAt: string;
}

// ---------------------------------------------------------------------------
// Fact rendering
// ---------------------------------------------------------------------------

function artifactLabel(artifact: Artifact | undefined, fallbackId: string): string {
  return artifact ? artifact.title : fallbackId;
}

function zoneLabel(zone: Zone | undefined, fallbackId: string): string {
  return zone ? zone.name : fallbackId;
}

export function changeFacts(change: PlanChange, state: WorkspaceState): PlanFactExpectation[] {
  switch (change.kind) {
    case 'preferences': {
      const paceLabel = (pace: PlanningPreferences['pace']) => `${pace[0].toUpperCase()}${pace.slice(1)} pace`;
      return [{
        key: 'preferences',
        label: 'Visitor profile',
        before: `${paceLabel(state.preferences.pace)}, group ${state.preferences.groupSize}, access ${state.preferences.accessibilityPriority}%`,
        after: `${paceLabel(change.preferences.pace)}, group ${change.preferences.groupSize}, access ${change.preferences.accessibilityPriority}%`,
      }];
    }
    case 'artifact-dwell': {
      const artifact = state.artifacts.find((candidate) => candidate.id === change.artifactId);
      const before = artifact ? artifact.dwellMinutes : 0;
      return [{
        key: `artifact-dwell:${change.artifactId}`,
        label: `Object stay · ${artifactLabel(artifact, change.artifactId)}`,
        before: `${before} min`,
        after: `${change.dwellMinutes} min`,
      }];
    }
    case 'zone-seating': {
      const zone = state.zones.find((candidate) => candidate.id === change.zoneId);
      return [{
        key: `zone-seating:${change.zoneId}`,
        label: `Seating · ${zoneLabel(zone, change.zoneId)}`,
        before: zone?.hasSeating ? 'Seating available' : 'No seating',
        after: change.hasSeating ? 'Seating available' : 'No seating',
      }];
    }
    case 'artifact-move': {
      const artifact = state.artifacts.find((candidate) => candidate.id === change.artifactId);
      const fromZone = state.zones.find((candidate) => candidate.id === change.fromZoneId);
      const toZone = state.zones.find((candidate) => candidate.id === change.toZoneId);
      return [{
        key: `artifact-placement:${change.artifactId}`,
        label: `Placement · ${artifactLabel(artifact, change.artifactId)}`,
        before: zoneLabel(fromZone, change.fromZoneId),
        after: zoneLabel(toZone, change.toZoneId),
      }];
    }
  }
}

function factConflictKey(change: PlanChange): string | null {
  switch (change.kind) {
    case 'artifact-dwell': return `artifact-dwell:${change.artifactId}`;
    case 'zone-seating': return `zone-seating:${change.zoneId}`;
    case 'artifact-move': return `artifact-placement:${change.artifactId}`;
    case 'preferences': return 'preferences';
  }
}

// ---------------------------------------------------------------------------
// Change application (pure; assumes the batch was already validated)
// ---------------------------------------------------------------------------

function stampRevision(state: WorkspaceState): WorkspaceState {
  return { ...state, revision: state.revision + 1, lastSavedAt: new Date().toISOString() };
}

function applyOneChange(state: WorkspaceState, change: PlanChange): WorkspaceState {
  switch (change.kind) {
    case 'preferences':
      return { ...state, preferences: clampScenario(change.preferences) };
    case 'artifact-dwell':
      return {
        ...state,
        artifacts: state.artifacts.map((artifact) =>
          artifact.id === change.artifactId
            ? { ...artifact, dwellMinutes: change.dwellMinutes, updatedAt: new Date().toISOString() }
            : artifact,
        ),
      };
    case 'zone-seating':
      return {
        ...state,
        zones: state.zones.map((zone) =>
          zone.id === change.zoneId ? { ...zone, hasSeating: change.hasSeating } : zone,
        ),
      };
    case 'artifact-move': {
      const withoutArtifact: WorkspaceState = {
        ...state,
        zones: state.zones.map((zone) => ({
          ...zone,
          artifactIds: zone.artifactIds.filter((id) => id !== change.artifactId),
        })),
      };
      return {
        ...withoutArtifact,
        zones: withoutArtifact.zones.map((zone) => {
          if (zone.id !== change.toZoneId) return zone;
          const index = Math.max(0, Math.min(change.index, zone.artifactIds.length));
          const artifactIds = [...zone.artifactIds];
          artifactIds.splice(index, 0, change.artifactId);
          return { ...zone, artifactIds };
        }),
      };
    }
  }
}

function appliesPlanChanges(state: WorkspaceState, changes: PlanChange[]): WorkspaceState {
  return changes.reduce((current, change) => applyOneChange(current, change), state);
}

// Structural changes (everything except visitor preferences) can invalidate
// readiness, mirroring the other plan-editing commands.
function touchesPlanStructure(changes: PlanChange[]): boolean {
  return changes.some((change) => change.kind !== 'preferences');
}

// ---------------------------------------------------------------------------
// Suggestion generation
// ---------------------------------------------------------------------------

const MAX_TRIM_MINUTES = 2;
const DURATION_TARGET_MINUTES = 55;
const MOVE_OPTIONS_PER_ZONE = 3;

function pressureThreshold(groupSize: number): number {
  return groupSize >= 10 ? 0.7 : groupSize >= 6 ? 0.82 : 0.95;
}

function dwellOf(artifacts: Artifact[], id: string): number {
  return artifacts.find((artifact) => artifact.id === id)?.dwellMinutes ?? 0;
}

function zoneMinutes(zone: Zone, artifacts: Artifact[]): number {
  return zone.artifactIds.reduce((total, id) => total + dwellOf(artifacts, id), 0);
}

function scoreTargetZone(artifact: Artifact, zone: Zone, artifacts: Artifact[], needsTrim: number): number {
  const minutes = zoneMinutes(zone, artifacts);
  const afterMinutes = minutes + Math.max(0, artifact.dwellMinutes - needsTrim);
  if (afterMinutes > zone.capacityMinutes) return -100;
  if (zone.artifactIds.length + 1 > zone.maxObjects) return -100;
  let score = zone.capacityMinutes - afterMinutes;
  if (artifact.sensitivity === 'low-light') score += zone.lowLight ? 40 : -80;
  if (artifact.accessibilityNeed === 'seating') score += zone.hasSeating ? 20 : -25;
  return score;
}

export interface BuildSuggestionsInput {
  pace: PlanningPreferences['pace'];
  accessibilityPriority: number;
  groupSize: number;
}

export function buildPlanSuggestions(state: WorkspaceState, analysis: JourneyAnalysis, input: BuildSuggestionsInput): PlanSuggestion[] {
  const scenario = clampScenario({ pace: input.pace, accessibilityPriority: input.accessibilityPriority, groupSize: input.groupSize });
  const projection = projectScenario(state, analysis, scenario);
  const suggestions: PlanSuggestion[] = [];

  // M1 — adopt the drafted visitor profile as saved planning preferences.
  const preferenceDiffers =
    state.preferences.pace !== scenario.pace
    || state.preferences.accessibilityPriority !== scenario.accessibilityPriority
    || state.preferences.groupSize !== scenario.groupSize;
  if (preferenceDiffers) {
    suggestions.push({
      id: 'suggest-adopt-profile',
      title: `Adopt the ${scenario.pace} visitor profile`,
      detail: `Save ${scenario.pace} pacing for groups of ${scenario.groupSize} with accessibility priority ${scenario.accessibilityPriority}%.`,
      category: 'visit-preferences',
      changes: [{ kind: 'preferences', preferences: scenario }],
      requires: [],
    });
  }

  // Trim suggestions shared between duration advice and pressure relief.
  const trimSuggestions = new Map<string, PlanSuggestion>();
  const ensureTrim = (artifact: Artifact, reduction: number, reason: string): PlanSuggestion => {
    const existing = trimSuggestions.get(artifact.id);
    if (existing) {
      const dwellChange = existing.changes.find((change): change is ArtifactDwellChange => change.kind === 'artifact-dwell');
      if (dwellChange && artifact.dwellMinutes - dwellChange.dwellMinutes < reduction) {
        dwellChange.dwellMinutes = artifact.dwellMinutes - reduction;
        existing.detail = `Shorten the planned stay for ${artifact.title} to ${artifact.dwellMinutes - reduction} minutes.`;
      }
      return existing;
    }
    const suggestion: PlanSuggestion = {
      id: `suggest-trim-${artifact.id}`,
      title: `Shorten stay at ${artifact.title}`,
      detail: `Shorten the planned stay for ${artifact.title} to ${artifact.dwellMinutes - reduction} minutes.`,
      category: 'object-dwell',
      changes: [{ kind: 'artifact-dwell', artifactId: artifact.id, dwellMinutes: artifact.dwellMinutes - reduction, reason }],
      requires: [],
    };
    trimSuggestions.set(artifact.id, suggestion);
    suggestions.push(suggestion);
    return suggestion;
  };

  // M2 — shorten the longest stays when the projected visit overruns.
  if (projection.durationMinutes > DURATION_TARGET_MINUTES) {
    const overrun = projection.durationMinutes - DURATION_TARGET_MINUTES;
    const longest = [...state.artifacts]
      .filter((artifact) => artifact.dwellMinutes > 2)
      .sort((left, right) => right.dwellMinutes - left.dwellMinutes)
      .slice(0, Math.min(3, Math.ceil(overrun / 2)));
    for (const artifact of longest) {
      ensureTrim(artifact, Math.min(MAX_TRIM_MINUTES, artifact.dwellMinutes - 2), 'Projected visit runs long.');
    }
  }

  // M3 — relieve pressure zones by moving their heaviest objects elsewhere.
  const threshold = pressureThreshold(scenario.groupSize);
  const pressured = analysis.zones.filter((zone) => Math.max(zone.utilization, zone.objectUtilization) >= threshold);
  for (const zoneAnalysis of pressured) {
    const sourceZone = state.zones.find((zone) => zone.id === zoneAnalysis.zoneId);
    if (!sourceZone) continue;
    const placed = sourceZone.artifactIds
      .map((id) => state.artifacts.find((artifact) => artifact.id === id))
      .filter((artifact): artifact is Artifact => Boolean(artifact))
      .sort((left, right) => right.dwellMinutes - left.dwellMinutes);

    let emitted = 0;
    // Reserve target zones across all moves suggested for this pressure zone
    // so two objects are never both sent to the same destination.
    const reservedTargets = new Set<string>();
    for (const artifact of placed) {
      if (emitted >= MOVE_OPTIONS_PER_ZONE) break;
      const targets = state.zones
        .filter((zone) => zone.id !== sourceZone.id)
        .map((zone) => {
          // Direct fit first; a trim dependency second.
          const direct = scoreTargetZone(artifact, zone, state.artifacts, 0);
          const withTrim = scoreTargetZone(artifact, zone, state.artifacts, MAX_TRIM_MINUTES);
          return { zone, direct, withTrim };
        })
        .filter((candidate) => candidate.direct >= 0 || candidate.withTrim >= 0)
        .sort((left, right) => {
          const leftFit = left.direct >= 0 ? left.direct + 1000 : left.withTrim;
          const rightFit = right.direct >= 0 ? right.direct + 1000 : right.withTrim;
          return rightFit - leftFit;
        });
      const target = targets.find((candidate) => !reservedTargets.has(candidate.zone.id));
      if (!target) continue;
      reservedTargets.add(target.zone.id);

      const requires: string[] = [];
      if (target.direct < 0) {
        const trim = ensureTrim(artifact, MAX_TRIM_MINUTES, `Frees capacity to move ${artifact.title} out of ${sourceZone.name}.`);
        requires.push(trim.id);
      }
      const seatingNeeded = artifact.accessibilityNeed === 'seating' && !target.zone.hasSeating;
      const seatingId = `suggest-seating-${target.zone.id}`;
      if (seatingNeeded && !suggestions.some((suggestion) => suggestion.id === seatingId)) {
        suggestions.push({
          id: seatingId,
          title: `Add seating to ${target.zone.name}`,
          detail: `${artifact.title} needs seated interpretation, so ${target.zone.name} requires seating before the move.`,
          category: 'access',
          changes: [{ kind: 'zone-seating', zoneId: target.zone.id, hasSeating: true }],
          requires: [],
        });
      }
      if (seatingNeeded) requires.push(seatingId);

      suggestions.push({
        id: `suggest-move-${artifact.id}-${target.zone.id}`,
        title: `Move ${artifact.title} to ${target.zone.shortLabel}`,
        detail: `Relieve ${sourceZone.name} by placing ${artifact.title} in ${target.zone.name}.`,
        category: 'zone-pressure',
        changes: [{
          kind: 'artifact-move',
          artifactId: artifact.id,
          fromZoneId: sourceZone.id,
          toZoneId: target.zone.id,
          index: target.zone.artifactIds.length,
        }],
        requires,
      });
      emitted += 1;
    }
  }

  // M4 — standalone seating advice for objects placed in zones without seating.
  for (const zone of state.zones) {
    if (zone.hasSeating) continue;
    const seatedArtifact = zone.artifactIds
      .map((id) => state.artifacts.find((artifact) => artifact.id === id))
      .find((artifact): artifact is Artifact => artifact !== undefined && artifact.accessibilityNeed === 'seating');
    const seatingId = `suggest-seating-${zone.id}`;
    if (seatedArtifact && !suggestions.some((suggestion) => suggestion.id === seatingId)) {
      suggestions.push({
        id: seatingId,
        title: `Add seating to ${zone.name}`,
        detail: `${seatedArtifact.title} is interpreted seated but ${zone.name} has no seating.`,
        category: 'access',
        changes: [{ kind: 'zone-seating', zoneId: zone.id, hasSeating: true }],
        requires: [],
      });
    }
  }

  return suggestions;
}

// ---------------------------------------------------------------------------
// Batch preparation and validation
// ---------------------------------------------------------------------------

function pushIssue(issues: PlanBatchIssue[], issue: PlanBatchIssue): void {
  if (!issues.some((existing) => existing.code === issue.code && existing.message === issue.message && existing.suggestionId === issue.suggestionId)) {
    issues.push(issue);
  }
}

export function validatePlanChanges(
  state: WorkspaceState,
  changes: PlanChange[],
  baseRevision?: number,
  capacityBaseline?: WorkspaceState,
): PlanBatchIssue[] {
  const issues: PlanBatchIssue[] = [];

  if (baseRevision !== undefined && state.revision !== baseRevision) {
    pushIssue(issues, {
      code: 'version-conflict',
      blocking: true,
      message: `The plan changed since these changes were prepared (revision ${baseRevision} → ${state.revision}). Reload the latest plan and retry.`,
    });
  }

  for (const change of changes) {
    switch (change.kind) {
      case 'artifact-dwell': {
        const artifact = state.artifacts.find((candidate) => candidate.id === change.artifactId);
        if (!artifact) {
          pushIssue(issues, { code: 'invalid-object', blocking: true, message: `Object ${change.artifactId} no longer exists in the collection.`, artifactId: change.artifactId });
        } else if (!Number.isFinite(change.dwellMinutes) || change.dwellMinutes <= 0) {
          pushIssue(issues, { code: 'fact-mismatch', blocking: true, message: `${artifact.title} requires a positive dwell time.`, artifactId: change.artifactId });
        }
        break;
      }
      case 'zone-seating': {
        if (!state.zones.some((zone) => zone.id === change.zoneId)) {
          pushIssue(issues, { code: 'invalid-zone', blocking: true, message: `Zone ${change.zoneId} no longer exists.`, zoneId: change.zoneId });
        }
        break;
      }
      case 'artifact-move': {
        const artifact = state.artifacts.find((candidate) => candidate.id === change.artifactId);
        if (!artifact) {
          pushIssue(issues, { code: 'invalid-object', blocking: true, message: `Object ${change.artifactId} no longer exists in the collection.`, artifactId: change.artifactId });
        }
        const fromZone = state.zones.find((zone) => zone.id === change.fromZoneId);
        const toZone = state.zones.find((zone) => zone.id === change.toZoneId);
        if (!fromZone) pushIssue(issues, { code: 'invalid-zone', blocking: true, message: `Source zone ${change.fromZoneId} no longer exists.`, zoneId: change.fromZoneId });
        if (!toZone) pushIssue(issues, { code: 'invalid-zone', blocking: true, message: `Target zone ${change.toZoneId} no longer exists.`, zoneId: change.toZoneId });
        if (artifact && fromZone && !fromZone.artifactIds.includes(change.artifactId)) {
          pushIssue(issues, {
            code: 'fact-mismatch',
            blocking: true,
            message: `${artifact.title} is no longer placed in ${fromZone.name}.`,
            artifactId: change.artifactId,
            zoneId: fromZone.id,
          });
        }
        break;
      }
      case 'preferences':
        break;
    }
  }

  // Two changes must never write the same plan fact (combination conflict).
  const owners = new Map<string, number>();
  changes.forEach((change, index) => {
    const key = factConflictKey(change);
    if (!key) return;
    const previous = owners.get(key);
    if (previous !== undefined) {
      pushIssue(issues, {
        code: 'fact-conflict',
        blocking: true,
        message: 'Selected suggestions modify the same plan fact in different ways.',
      });
    } else {
      owners.set(key, index);
    }
  });

  // Capacity relationships must hold once the whole batch lands.
  if (!issues.some((issue) => issue.blocking)) {
    const projected = appliesPlanChanges(state, changes);
    const projectedAnalysis = analyzeJourney(projected.artifacts, projected.zones);
    // Forward batches compare against the live plan; reverts compare against
    // the pre-commit state, since restoring a previously valid (if tight) zone
    // is not a new breach.
    const baselineState = capacityBaseline ?? state;
    const baselineAnalysis = analyzeJourney(baselineState.artifacts, baselineState.zones);
    const baselineById = new Map(baselineAnalysis.zones.map((zone) => [zone.zoneId, zone]));
    const touchedZones = new Set<string>();
    for (const change of changes) {
      if (change.kind === 'artifact-move') {
        touchedZones.add(change.fromZoneId);
        touchedZones.add(change.toZoneId);
      }
      if (change.kind === 'artifact-dwell') {
        for (const zone of state.zones) {
          if (zone.artifactIds.includes(change.artifactId)) touchedZones.add(zone.id);
        }
      }
      if (change.kind === 'zone-seating') touchedZones.add(change.zoneId);
    }
    for (const projectedZone of projectedAnalysis.zones) {
      if (!touchedZones.has(projectedZone.zoneId)) continue;
      const baseline = baselineById.get(projectedZone.zoneId);
      const dwellBreach = projectedZone.utilization > 1 && (!baseline || projectedZone.utilization > baseline.utilization);
      const objectBreach = projectedZone.objectUtilization > 1 && (!baseline || projectedZone.objectUtilization > baseline.objectUtilization);
      const zone = projected.zones.find((candidate) => candidate.id === projectedZone.zoneId);
      if (dwellBreach) {
        pushIssue(issues, {
          code: 'capacity-exceeded',
          blocking: true,
          message: `${zone?.name ?? projectedZone.zoneId} would run at ${Math.round(projectedZone.utilization * 100)}% of its dwell capacity.`,
          zoneId: projectedZone.zoneId,
        });
      }
      if (objectBreach) {
        pushIssue(issues, {
          code: 'capacity-exceeded',
          blocking: true,
          message: `${zone?.name ?? projectedZone.zoneId} would hold ${projectedZone.objectCount} objects against a limit of ${zone?.maxObjects ?? 0}.`,
          zoneId: projectedZone.zoneId,
        });
      }
    }
  }

  return issues;
}

export function preparePlanBatch(
  state: WorkspaceState,
  suggestions: PlanSuggestion[],
  selectedIds: string[],
  scenarioInput: ScenarioInput,
): PlanBatchPreview {
  const selected = selectedIds
    .map((id) => suggestions.find((suggestion) => suggestion.id === id))
    .filter((suggestion): suggestion is PlanSuggestion => Boolean(suggestion));
  const issues: PlanBatchIssue[] = [];

  for (const id of selectedIds) {
    if (!suggestions.some((suggestion) => suggestion.id === id)) {
      pushIssue(issues, {
        code: 'unknown-suggestion',
        blocking: true,
        message: 'A selected suggestion is no longer available for the current plan.',
        suggestionId: id,
      });
    }
  }

  // Dependencies must be satisfied inside the selection.
  const selectedSet = new Set(selected.map((suggestion) => suggestion.id));
  const dependencies: PlanBatchPreview['dependencies'] = [];
  for (const suggestion of selected) {
    for (const requiresId of suggestion.requires) {
      const satisfied = selectedSet.has(requiresId);
      dependencies.push({ suggestionId: suggestion.id, requiresId, satisfied });
      if (!satisfied) {
        pushIssue(issues, {
          code: 'missing-dependency',
          blocking: true,
          message: `"${suggestion.title}" depends on another suggestion that is not selected.`,
          suggestionId: suggestion.id,
        });
      }
    }
  }

  const changes = selected.flatMap((suggestion) => suggestion.changes);
  for (const issue of validatePlanChanges(state, changes, state.revision)) pushIssue(issues, issue);

  // Aggregate fact deltas for the review panel.
  const deltaMap = new Map<string, PlanFactDelta>();
  for (const suggestion of selected) {
    for (const change of suggestion.changes) {
      for (const fact of changeFacts(change, state)) {
        const existing = deltaMap.get(fact.key);
        if (existing) {
          existing.suggestionIds.push(suggestion.id);
        } else {
          deltaMap.set(fact.key, { ...fact, suggestionIds: [suggestion.id] });
        }
      }
    }
  }

  const baselineAnalysis = analyzeJourney(state.artifacts, state.zones);
  const baselineProjection = projectScenario(state, baselineAnalysis, scenarioInput);
  const projectedState = appliesPlanChanges(state, changes);
  const projectedAnalysis = analyzeJourney(projectedState.artifacts, projectedState.zones);
  const projectedProjection = projectScenario(projectedState, projectedAnalysis, scenarioInput);

  // Non-blocking predicted journey findings created by the batch (e.g. moving
  // an object into a brighter zone). Pre-existing findings are not re-reported.
  const baselineFindingIds = new Set(baselineAnalysis.findings.map((finding) => finding.id));
  for (const finding of projectedAnalysis.findings) {
    if (finding.type === 'error' && !baselineFindingIds.has(finding.id)) {
      pushIssue(issues, {
        code: 'predicted-warning',
        blocking: false,
        message: finding.detail ? `${finding.title}: ${finding.detail}` : finding.title,
        zoneId: finding.zoneId,
        artifactId: finding.artifactId,
      });
    }
  }

  return {
    suggestionIds: selectedIds,
    baseRevision: state.revision,
    scenarioInput: clampScenario(scenarioInput),
    suggestions: selected,
    factDeltas: Array.from(deltaMap.values()),
    dependencies,
    issues,
    prediction: {
      durationMinutes: projectedProjection.durationMinutes,
      comfortScore: projectedProjection.comfortScore,
      accessibilityScore: projectedProjection.accessibilityScore,
      narrativeScore: projectedProjection.narrativeScore,
      pressureZoneIds: projectedProjection.pressureZoneIds,
      blockingJourneyCount: projectedAnalysis.blockingCount,
      warningJourneyCount: projectedAnalysis.warningCount,
      deltas: {
        durationMinutes: projectedProjection.durationMinutes - baselineProjection.durationMinutes,
        comfortScore: projectedProjection.comfortScore - baselineProjection.comfortScore,
        accessibilityScore: projectedProjection.accessibilityScore - baselineProjection.accessibilityScore,
        narrativeScore: projectedProjection.narrativeScore - baselineProjection.narrativeScore,
      },
    },
    canCommit: !issues.some((issue) => issue.blocking),
  };
}

// ---------------------------------------------------------------------------
// Commit / revert
// ---------------------------------------------------------------------------

export function summarizeChanges(changes: PlanChange[], state: WorkspaceState): string {
  const parts = changes.map((change) => {
    switch (change.kind) {
      case 'preferences': return 'visitor profile';
      case 'artifact-dwell': {
        const artifact = state.artifacts.find((candidate) => candidate.id === change.artifactId);
        return artifact ? `stay at ${artifact.title}` : 'object stay';
      }
      case 'zone-seating': {
        const zone = state.zones.find((candidate) => candidate.id === change.zoneId);
        return zone ? `seating in ${zone.shortLabel}` : 'zone seating';
      }
      case 'artifact-move': {
        const artifact = state.artifacts.find((candidate) => candidate.id === change.artifactId);
        return artifact ? `moved ${artifact.title}` : 'moved object';
      }
    }
  });
  const unique = Array.from(new Set(parts));
  if (unique.length <= 2) return unique.join(' and ');
  return `${unique.slice(0, -1).join(', ')}, and ${unique[unique.length - 1]}`;
}

export function commitPlanTransaction(
  state: WorkspaceState,
  preview: Pick<PlanBatchPreview, 'suggestionIds' | 'baseRevision' | 'suggestions'>,
  options: { id: string; at?: Date },
): { state: WorkspaceState; transaction: PlanTransaction } {
  const changes = preview.suggestions.flatMap((suggestion) => suggestion.changes);
  const issues = validatePlanChanges(state, changes, preview.baseRevision);
  if (issues.some((issue) => issue.blocking)) {
    throw new PlanTransactionError(issues);
  }
  const summary = summarizeChanges(changes, state);
  let next = appliesPlanChanges(state, changes);
  if (touchesPlanStructure(changes)) next = regressReadyProject(next);
  next = stampRevision(next);
  const at = (options.at ?? new Date()).toISOString();
  return {
    state: next,
    transaction: {
      id: options.id,
      suggestionIds: preview.suggestionIds,
      baseRevision: preview.baseRevision,
      committedRevision: next.revision,
      changes,
      inverseChanges: invertPlanChanges(changes, state),
      baseArtifacts: state.artifacts,
      baseZones: state.zones,
      summary,
      appliedAt: at,
    },
  };
}

export class PlanTransactionError extends Error {
  constructor(public readonly issues: PlanBatchIssue[]) {
    super(issues[0]?.message ?? 'The planning batch could not be applied.');
    this.name = 'PlanTransactionError';
  }
}

// Before reverting, every fact the transaction wrote must still hold its
// post-commit value; otherwise undo would silently clobber a later edit (for
// example a dwell adjusted again by another command after the transaction).
export function validateRevertFacts(state: WorkspaceState, changes: PlanChange[]): PlanBatchIssue[] {
  const issues: PlanBatchIssue[] = [];
  for (const change of changes) {
    switch (change.kind) {
      case 'preferences': {
        const current = state.preferences;
        if (current.pace !== change.preferences.pace
          || current.groupSize !== change.preferences.groupSize
          || current.accessibilityPriority !== change.preferences.accessibilityPriority) {
          pushIssue(issues, { code: 'fact-mismatch', blocking: true, message: 'The visitor profile changed again after this transaction; undo is disabled to protect the newer setting.' });
        }
        break;
      }
      case 'artifact-dwell': {
        const artifact = state.artifacts.find((candidate) => candidate.id === change.artifactId);
        if (!artifact) {
          pushIssue(issues, { code: 'invalid-object', blocking: true, message: `Object ${change.artifactId} no longer exists.`, artifactId: change.artifactId });
        } else if (artifact.dwellMinutes !== change.dwellMinutes) {
          pushIssue(issues, { code: 'fact-mismatch', blocking: true, message: `${artifact.title}'s planned stay changed again after this transaction; undo is disabled to protect the newer value.`, artifactId: change.artifactId });
        }
        break;
      }
      case 'zone-seating': {
        const zone = state.zones.find((candidate) => candidate.id === change.zoneId);
        if (!zone) {
          pushIssue(issues, { code: 'invalid-zone', blocking: true, message: `Zone ${change.zoneId} no longer exists.`, zoneId: change.zoneId });
        } else if (zone.hasSeating !== change.hasSeating) {
          pushIssue(issues, { code: 'fact-mismatch', blocking: true, message: `Seating in ${zone.name} changed again after this transaction; undo is disabled to protect the newer setting.`, zoneId: change.zoneId });
        }
        break;
      }
      case 'artifact-move':
        break;
    }
  }
  return issues;
}

export function invertPlanChanges(changes: PlanChange[], baseline: WorkspaceState): PlanChange[] {
  // Inverse changes restore the values captured from the pre-commit baseline
  // and are applied in reverse order so later moves are undone first.
  return [...changes].reverse().map((change): PlanChange => {
    switch (change.kind) {
      case 'preferences':
        return { kind: 'preferences', preferences: { ...baseline.preferences } };
      case 'artifact-dwell': {
        const artifact = baseline.artifacts.find((candidate) => candidate.id === change.artifactId);
        return {
          kind: 'artifact-dwell',
          artifactId: change.artifactId,
          dwellMinutes: artifact?.dwellMinutes ?? change.dwellMinutes,
          reason: 'Undo planning transaction',
        };
      }
      case 'zone-seating': {
        const zone = baseline.zones.find((candidate) => candidate.id === change.zoneId);
        return { kind: 'zone-seating', zoneId: change.zoneId, hasSeating: zone?.hasSeating ?? !change.hasSeating };
      }
      case 'artifact-move': {
        const fromZone = baseline.zones.find((zone) => zone.id === change.fromZoneId);
        const currentIndex = fromZone?.artifactIds.indexOf(change.artifactId) ?? -1;
        return {
          kind: 'artifact-move',
          artifactId: change.artifactId,
          fromZoneId: change.toZoneId,
          toZoneId: change.fromZoneId,
          index: currentIndex >= 0 ? currentIndex : 0,
        };
      }
    }
  });
}

export function revertPlanTransaction(
  state: WorkspaceState,
  transaction: PlanTransaction,
  options: { at?: Date } = {},
): WorkspaceState {
  // Guard the revert against the live state: a move can only be undone if the
  // object is still in the zone the transaction placed it in. The values
  // restored come from the inverse captured at commit time, and capacity is
  // compared against the plan as it existed before the transaction.
  const beforeCommit: WorkspaceState = {
    ...state,
    revision: transaction.baseRevision,
    artifacts: transaction.baseArtifacts,
    zones: transaction.baseZones,
  };
  const factIssues = validateRevertFacts(state, transaction.changes);
  const issues = [...factIssues, ...validatePlanChanges(state, transaction.inverseChanges, undefined, beforeCommit)];
  if (issues.some((issue) => issue.blocking)) {
    throw new PlanTransactionError(issues);
  }
  let next = appliesPlanChanges(state, transaction.inverseChanges);
  if (touchesPlanStructure(transaction.inverseChanges)) next = regressReadyProject(next);
  const stamped = stampRevision(next);
  return options.at ? { ...stamped, lastSavedAt: options.at.toISOString() } : stamped;
}
