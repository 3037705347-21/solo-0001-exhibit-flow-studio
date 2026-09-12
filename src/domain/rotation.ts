import { addDays } from './dateMath';
import { createId } from './ids';
import type {
  Artifact,
  RotationBatch,
  RotationBatchHealth,
  RotationBatchState,
  RotationClass,
  RotationDependency,
  RotationPlan,
  RotationPlanExport,
  RotationPlanHealth,
  RotationPlanStatus,
  RotationStint,
  Sensitivity,
  WorkspaceState,
  Zone,
} from './models';

/**
 * Rotation scheduling.
 *
 * Low-light-sensitive and fragile objects must alternate between display and
 * rest. Every confirmed batch is pinned to the exact object and zone versions
 * it was generated from; if either side changes afterwards the batch (and the
 * plan it belongs to) drops out of the confirmed state until it is reviewed.
 */

export const ROTATION_HORIZON_DAYS = 240;

export const ROTATION_PROFILES: Record<RotationClass, { displayDays: number; restDays: number }> = {
  'low-light': { displayDays: 42, restDays: 28 },
  fragile: { displayDays: 28, restDays: 42 },
};

export const ROTATION_CLASS_LABELS: Record<RotationClass, string> = {
  'low-light': 'Low-light rotation',
  fragile: 'Fragile object rotation',
};

export function requiresRotation(sensitivity: Sensitivity): sensitivity is RotationClass {
  return sensitivity === 'low-light' || sensitivity === 'fragile';
}

function stableHash(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36).padStart(7, '0');
}

export function artifactVersionFingerprint(artifact: Artifact): string {
  return stableHash([
    artifact.id,
    artifact.sensitivity,
    artifact.dwellMinutes,
    artifact.dimensions.width,
    artifact.dimensions.height,
    artifact.dimensions.depth,
    artifact.updatedAt,
  ].join('|'));
}

export function zoneVersionFingerprint(zone: Zone): string {
  return stableHash([
    zone.id,
    zone.lowLight ? 1 : 0,
    zone.capacityMinutes,
    zone.maxObjects,
    zone.hasSeating ? 1 : 0,
  ].join('|'));
}

function zoneForArtifact(state: WorkspaceState, artifactId: string): Zone | undefined {
  return state.zones.find((zone) => zone.artifactIds.includes(artifactId));
}

function buildDependency(state: WorkspaceState, artifact: Artifact): RotationDependency {
  const zone = zoneForArtifact(state, artifact.id);
  return {
    artifactId: artifact.id,
    artifactTitle: artifact.title,
    sensitivity: artifact.sensitivity,
    artifactVersion: artifactVersionFingerprint(artifact),
    zoneId: zone?.id,
    zoneName: zone?.name,
    zoneVersion: zone ? zoneVersionFingerprint(zone) : undefined,
  };
}

export function buildStints(
  openingDate: string,
  dailyLoadMinutes: number,
  profile: { displayDays: number; restDays: number },
  zone: Zone | undefined,
  horizonDays: number,
): RotationStint[] {
  const stints: RotationStint[] = [];
  const cycle = profile.displayDays + profile.restDays;
  let cursor = openingDate;
  let guard = 0;
  while (guard < 100) {
    const displayEnd = addDays(cursor, profile.displayDays - 1);
    stints.push({
      kind: 'display',
      startDate: cursor,
      endDate: displayEnd,
      zoneId: zone?.id,
      zoneName: zone?.name,
      loadMinutes: dailyLoadMinutes * profile.displayDays,
    });
    const restStart = addDays(displayEnd, 1);
    const restEnd = addDays(restStart, profile.restDays - 1);
    stints.push({
      kind: 'rest',
      startDate: restStart,
      endDate: restEnd,
      loadMinutes: 0,
    });
    const next = addDays(cursor, cycle);
    if (addDays(next, -1) >= addDays(openingDate, horizonDays)) break;
    cursor = next;
    guard += 1;
  }
  return stints;
}

const CLASS_ORDER: Record<RotationClass, number> = { 'low-light': 0, fragile: 1 };

export function buildPlanWarnings(state: WorkspaceState, artifacts: Artifact[]): string[] {
  const warnings: string[] = [];
  for (const artifact of artifacts) {
    const zone = zoneForArtifact(state, artifact.id);
    if (requiresRotation(artifact.sensitivity) && zone && !zone.lowLight) {
      warnings.push(`${artifact.title} is ${artifact.sensitivity.replace('-', ' ')} sensitive but ${zone.name} is not a low-light zone.`);
    }
    if (!zone) {
      warnings.push(`${artifact.title} is not placed in a zone yet; display segments have no assigned gallery.`);
    }
  }
  return warnings;
}

function buildGeneratedBatch(state: WorkspaceState, artifact: Artifact, openingDate: string, horizonDays: number, now: Date): RotationBatch {
  const rotationClass = artifact.sensitivity as RotationClass;
  const profile = ROTATION_PROFILES[rotationClass];
  const zone = zoneForArtifact(state, artifact.id);
  const timestamp = now.toISOString();
  return {
    id: createId('rotation-batch'),
    label: artifact.title.length > 24 ? `${artifact.title.slice(0, 24)}… rotation` : `${artifact.title} rotation`,
    rotationClass,
    displayDays: profile.displayDays,
    restDays: profile.restDays,
    artifactIds: [artifact.id],
    stints: buildStints(openingDate, artifact.dwellMinutes, profile, zone, horizonDays),
    dependencies: [buildDependency(state, artifact)],
    manual: false,
    updatedAt: timestamp,
  };
}

function planNameFor(openingDate: string): string {
  const date = new Date(`${openingDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return 'Rotation plan';
  return `Rotation plan · ${new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric' }).format(date)}`;
}

export function buildRotationPlan(state: WorkspaceState, at = new Date()): RotationPlan {
  const openingDate = state.project.openingDate;
  const horizonDays = ROTATION_HORIZON_DAYS;
  const rotationArtifacts = state.artifacts
    .filter((artifact) => requiresRotation(artifact.sensitivity))
    .sort((left, right) =>
      CLASS_ORDER[left.sensitivity as RotationClass] - CLASS_ORDER[right.sensitivity as RotationClass]
      || left.title.localeCompare(right.title));
  const timestamp = at.toISOString();
  const batches = rotationArtifacts.map((artifact) => buildGeneratedBatch(state, artifact, openingDate, horizonDays, at));
  return {
    id: createId('rotation-plan'),
    name: planNameFor(openingDate),
    status: 'draft',
    openingDate,
    horizonDays,
    batchIds: batches.map((batch) => batch.id),
    batches,
    warnings: buildPlanWarnings(state, rotationArtifacts),
    reviewReasons: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function evaluateBatch(state: WorkspaceState, batch: RotationBatch): RotationBatchHealth {
  const reasons: string[] = [];
  let batchState: RotationBatchState = 'ok';
  const artifactById = new Map(state.artifacts.map((artifact) => [artifact.id, artifact]));

  if (batch.artifactIds.length === 0) {
    batchState = 'missing';
    reasons.push('This batch no longer contains any objects.');
  }

  const liveArtifactIds = new Set<string>();
  for (const artifactId of batch.artifactIds) {
    const artifact = artifactById.get(artifactId);
    if (!artifact) {
      batchState = 'missing';
      reasons.push('An object assigned to this batch was removed from the collection.');
      continue;
    }
    liveArtifactIds.add(artifactId);
    const dependency = batch.dependencies.find((entry) => entry.artifactId === artifactId);
    if (!dependency) {
      batchState = 'missing';
      reasons.push(`${artifact.title} has no recorded object version in this batch.`);
      continue;
    }
    if (dependency.artifactVersion !== artifactVersionFingerprint(artifact)) {
      batchState = 'stale';
      reasons.push(`${artifact.title}'s sensitivity or display profile changed since this batch was confirmed.`);
    }
    if (dependency.sensitivity !== artifact.sensitivity) {
      batchState = 'stale';
      reasons.push(`${artifact.title}'s sensitivity classification is now ${artifact.sensitivity.replace('-', ' ')}.`);
    }
    const liveZone = zoneForArtifact(state, artifactId);
    const liveZoneVersion = liveZone ? zoneVersionFingerprint(liveZone) : undefined;
    if (dependency.zoneId && !liveZone) {
      batchState = 'stale';
      reasons.push(`${artifact.title} left ${dependency.zoneName ?? 'its zone'} after this batch was confirmed.`);
    } else if (!dependency.zoneId && liveZone) {
      batchState = 'stale';
      reasons.push(`${artifact.title} was placed into ${liveZone.name} after this batch was confirmed.`);
    } else if (dependency.zoneId && liveZone && dependency.zoneId !== liveZone.id) {
      batchState = 'stale';
      reasons.push(`${artifact.title} moved from ${dependency.zoneName ?? 'a zone'} to ${liveZone.name}.`);
    } else if (dependency.zoneVersion !== liveZoneVersion) {
      batchState = 'stale';
      reasons.push(`${liveZone?.name ?? 'The display zone'} lighting or capacity changed since this batch was confirmed.`);
    }
  }

  const coveredIds = new Set(batch.dependencies.map((dependency) => dependency.artifactId));
  for (const artifactId of batch.artifactIds) {
    if (!coveredIds.has(artifactId)) {
      batchState = 'missing';
      const artifact = artifactById.get(artifactId);
      reasons.push(`${artifact?.title ?? 'An object'} is missing its pinned version.`);
    }
  }

  return { batchId: batch.id, label: batch.label, state: batchState, reasons: Array.from(new Set(reasons)) };
}

/**
 * Read-only health check. Confirmed plans with any drift report status
 * `review`; the plan's stored status is never mutated here.
 */
export function evaluateRotationPlan(state: WorkspaceState, plan: RotationPlan): RotationPlanHealth {
  const batches = plan.batches.map((batch) => evaluateBatch(state, batch));
  const staleBatchIds = batches.filter((batch) => batch.state === 'stale').map((batch) => batch.batchId);
  const missingBatchIds = batches.filter((batch) => batch.state === 'missing').map((batch) => batch.batchId);

  const coveredArtifactIds = new Set(plan.batches.flatMap((batch) => batch.artifactIds));
  const uncoveredSensitive = state.artifacts
    .filter((artifact) => requiresRotation(artifact.sensitivity) && !coveredArtifactIds.has(artifact.id))
    .map((artifact) => artifact.title);

  const reasons: string[] = [];
  const openingDateMismatch = plan.openingDate !== state.project.openingDate;
  if (openingDateMismatch) {
    reasons.push(`The planned opening moved from ${plan.openingDate} to ${state.project.openingDate}.`);
  }
  if (missingBatchIds.length > 0) reasons.push(`${missingBatchIds.length} batch${missingBatchIds.length === 1 ? '' : 'es'} reference removed objects or missing versions.`);
  if (staleBatchIds.length > 0) reasons.push(`${staleBatchIds.length} batch${staleBatchIds.length === 1 ? '' : 'es'} depend on object or gallery versions that changed.`);
  if (uncoveredSensitive.length > 0) {
    reasons.push(`${uncoveredSensitive.join(', ')} ${uncoveredSensitive.length === 1 ? 'needs' : 'all need'} rotation but ${uncoveredSensitive.length === 1 ? 'is' : 'are'} not in this plan.`);
  }

  const canConfirm = missingBatchIds.length === 0 && uncoveredSensitive.length === 0;
  const drifted = openingDateMismatch || staleBatchIds.length > 0 || missingBatchIds.length > 0 || uncoveredSensitive.length > 0;
  // A stored review/draft status is never auto-promoted: a human must re-confirm.
  // A confirmed plan whose dependencies drifted is defensively displayed as
  // review even before reconciliation persists that transition.
  const status: RotationPlanStatus = plan.status === 'confirmed' && drifted ? 'review' : plan.status;

  return {
    planId: plan.id,
    status,
    openingDateMismatch,
    batches,
    reasons,
    warnings: plan.warnings,
    uncoveredSensitive,
    canConfirm,
    staleBatchIds,
    missingBatchIds,
  };
}

/**
 * Reconciles every plan against the current workspace. Confirmed plans with
 * drift are persisted as `review` with human-readable reasons; plans whose
 * dependencies all still match keep their stored status. Warnings are always
 * recomputed from the current state.
 */
export function reconcileRotationPlans(state: WorkspaceState, at = new Date()): RotationPlan[] {
  return state.rotationPlans.map((plan) => {
    const coveredIds = new Set(plan.batches.flatMap((batch) => batch.artifactIds));
    const rotationArtifacts = state.artifacts.filter(
      (artifact) => requiresRotation(artifact.sensitivity) || coveredIds.has(artifact.id),
    );
    const warnings = buildPlanWarnings(state, rotationArtifacts);
    if (plan.status === 'draft') {
      return plan.warnings.join('|') === warnings.join('|') ? plan : { ...plan, warnings };
    }
    const health = evaluateRotationPlan(state, { ...plan, warnings });
    if (health.status === 'review' && plan.status !== 'review') {
      return { ...plan, status: 'review', reviewReasons: health.reasons, warnings, updatedAt: at.toISOString() };
    }
    if (plan.status === 'review') {
      return { ...plan, reviewReasons: health.reasons, warnings };
    }
    return plan.warnings.join('|') === warnings.join('|') ? plan : { ...plan, warnings };
  });
}

function rebuildBatchFromState(
  state: WorkspaceState,
  batch: RotationBatch,
  openingDate: string,
  at: Date,
): RotationBatch {
  const profile = ROTATION_PROFILES[batch.rotationClass];
  const artifacts = batch.artifactIds
    .map((id) => state.artifacts.find((artifact) => artifact.id === id))
    .filter((artifact): artifact is Artifact => Boolean(artifact));
  const timestamp = at.toISOString();
  const dailyLoadMinutes = artifacts.reduce((total, current) => total + current.dwellMinutes, 0);
  const primaryZoneId = artifacts.map((artifact) => zoneForArtifact(state, artifact.id)?.id).find((id): id is string => Boolean(id));
  const primaryZone = primaryZoneId ? state.zones.find((zone) => zone.id === primaryZoneId) : undefined;
  return {
    ...batch,
    displayDays: profile.displayDays,
    restDays: profile.restDays,
    stints: buildStints(
      openingDate,
      dailyLoadMinutes,
      profile,
      primaryZone,
      ROTATION_HORIZON_DAYS,
    ),
    dependencies: artifacts.map((artifact) => buildDependency(state, artifact)),
    updatedAt: timestamp,
  };
}

/**
 * Re-anchors a draft or review plan to the current workspace: stints are
 * rebuilt against the current opening date and every batch is re-pinned to
 * current object/zone versions. Plans referencing removed objects or missing
 * newly-sensitive objects cannot be re-confirmed until regenerated or fixed.
 */
export function syncConfirmedPlan(state: WorkspaceState, planId: string, at = new Date()): RotationPlan {
  const plan = state.rotationPlans.find((candidate) => candidate.id === planId);
  if (!plan) throw new Error('The rotation plan no longer exists.');
  const probeHealth = evaluateRotationPlan(state, plan);
  if (!probeHealth.canConfirm) {
    throw new Error(probeHealth.reasons[0] ?? 'Resolve missing objects before confirming this plan.');
  }
  const timestamp = at.toISOString();
  const batches = plan.batches.map((batch) => rebuildBatchFromState(state, batch, state.project.openingDate, at));
  return {
    ...plan,
    status: 'confirmed',
    openingDate: state.project.openingDate,
    horizonDays: ROTATION_HORIZON_DAYS,
    batchIds: batches.map((batch) => batch.id),
    batches,
    warnings: probeHealth.warnings,
    reviewReasons: [],
    confirmedAt: timestamp,
    updatedAt: timestamp,
  };
}

function requireEditablePlan(state: WorkspaceState, planId: string): RotationPlan {
  const plan = state.rotationPlans.find((candidate) => candidate.id === planId);
  if (!plan) throw new Error('The rotation plan no longer exists.');
  return plan;
}

function markDraft(plan: RotationPlan, batches: RotationBatch[], at: Date): RotationPlan {
  const timestamp = at.toISOString();
  return {
    ...plan,
    status: 'draft',
    batches,
    batchIds: batches.map((batch) => batch.id),
    reviewReasons: [],
    updatedAt: timestamp,
  };
}

export function renameRotationBatch(state: WorkspaceState, planId: string, batchId: string, label: string, at = new Date()): RotationPlan[] {
  const plan = requireEditablePlan(state, planId);
  const trimmed = label.trim();
  if (!trimmed) throw new Error('Batch label cannot be empty.');
  const timestamp = at.toISOString();
  const batches = plan.batches.map((batch) =>
    batch.id === batchId
      ? { ...batch, label: trimmed.slice(0, 60), manual: true, updatedAt: timestamp }
      : batch,
  );
  return state.rotationPlans.map((candidate) => (candidate.id === planId ? markDraft(plan, batches, at) : candidate));
}

export function moveArtifactToBatch(
  state: WorkspaceState,
  planId: string,
  artifactId: string,
  _fromBatchId: string | null,
  toBatchId: string,
  at = new Date(),
): RotationPlan[] {
  const plan = requireEditablePlan(state, planId);
  const artifact = state.artifacts.find((candidate) => candidate.id === artifactId);
  if (!artifact) throw new Error('The selected object no longer exists.');
  if (!requiresRotation(artifact.sensitivity)) {
    throw new Error('Only low-light-sensitive or fragile objects belong in rotation batches.');
  }
  const target = plan.batches.find((batch) => batch.id === toBatchId);
  if (!target) throw new Error('The target batch no longer exists.');
  if (target.rotationClass !== artifact.sensitivity) {
    throw new Error(`Move the object to a ${target.rotationClass.replace('-', ' ')} batch, or generate a plan that matches its sensitivity.`);
  }

  const timestamp = at.toISOString();
  const batches = plan.batches
    .map((batch) => {
      const remaining = batch.artifactIds.filter((id) => id !== artifactId);
      if (batch.id === toBatchId) {
        const artifactIds = remaining.includes(artifactId) ? remaining : [...remaining, artifactId];
        const merged: RotationBatch = {
          ...batch,
          artifactIds,
          label: batch.manual || artifactIds.length === 1 ? batch.label : `Mixed ${batch.rotationClass.replace('-', ' ')} batch`,
          manual: true,
        };
        return rebuildBatchFromState(state, merged, plan.openingDate, at);
      }
      if (remaining.length !== batch.artifactIds.length) {
        return rebuildBatchFromState(state, { ...batch, artifactIds: remaining, manual: true }, plan.openingDate, at);
      }
      return batch;
    })
    .filter((batch) => batch.artifactIds.length > 0);

  const updated = markDraft({ ...plan }, batches, at);
  return state.rotationPlans.map((candidate) => (candidate.id === planId ? { ...updated, updatedAt: timestamp } : candidate));
}

export function moveArtifactToNewBatch(
  state: WorkspaceState,
  planId: string,
  artifactId: string,
  fromBatchId: string | null,
  at = new Date(),
): RotationPlan[] {
  const plan = requireEditablePlan(state, planId);
  const artifact = state.artifacts.find((candidate) => candidate.id === artifactId);
  if (!artifact) throw new Error('The selected object no longer exists.');
  if (!requiresRotation(artifact.sensitivity)) {
    throw new Error('Only low-light-sensitive or fragile objects belong in rotation batches.');
  }
  const rotationClass = artifact.sensitivity;
  const profile = ROTATION_PROFILES[rotationClass];
  const timestamp = at.toISOString();
  const seed: RotationBatch = {
    id: createId('rotation-batch'),
    label: `${artifact.title} rotation`,
    rotationClass,
    displayDays: profile.displayDays,
    restDays: profile.restDays,
    artifactIds: [artifactId],
    stints: [],
    dependencies: [],
    manual: true,
    updatedAt: timestamp,
  };
  const newBatch = rebuildBatchFromState(state, seed, plan.openingDate, at);
  const sourceBatch = plan.batches.find((batch) => batch.id === fromBatchId);
  let batches = plan.batches.map((batch) =>
    batch.id === fromBatchId
      ? rebuildBatchFromState(state, { ...batch, artifactIds: batch.artifactIds.filter((id) => id !== artifactId), manual: sourceBatch?.manual ?? true }, plan.openingDate, at)
      : batch,
  );
  batches = batches.filter((batch) => batch.id !== fromBatchId || batch.artifactIds.length > 0);
  batches = [...batches, newBatch];
  const updated = markDraft(plan, batches, at);
  return state.rotationPlans.map((candidate) => (candidate.id === planId ? updated : candidate));
}

export function removeRotationPlan(state: WorkspaceState, planId: string): RotationPlan[] {
  return state.rotationPlans.filter((plan) => plan.id !== planId);
}

export function rotationPlanFileName(date = new Date()): string {
  return `exhibit-flow-rotation-${date.toISOString().slice(0, 10)}.json`;
}

export function buildRotationPlanExport(state: WorkspaceState, plan: RotationPlan, at = new Date()): RotationPlanExport {
  const health = evaluateRotationPlan(state, plan);
  const stateByBatch = new Map(health.batches.map((batch) => [batch.batchId, batch]));
  return {
    schemaVersion: 1,
    generatedAt: at.toISOString(),
    planId: plan.id,
    planName: plan.name,
    planStatus: health.status,
    openingDate: state.project.openingDate,
    horizonDays: plan.horizonDays,
    reviewReasons: health.reasons,
    warnings: plan.warnings,
    batches: plan.batches.map((batch) => {
      const batchHealth = stateByBatch.get(batch.id);
      return {
        batchId: batch.id,
        label: batch.label,
        rotationClass: batch.rotationClass,
        displayDays: batch.displayDays,
        restDays: batch.restDays,
        manual: batch.manual,
        state: batchHealth?.state ?? 'ok',
        stateReasons: batchHealth?.reasons ?? [],
        dependencies: batch.dependencies,
        stints: batch.stints,
      };
    }),
  };
}

export function serializeRotationPlanExport(exportPlan: RotationPlanExport): string {
  return JSON.stringify(exportPlan, null, 2);
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function rotationScheduleCsvFileName(date = new Date()): string {
  return `exhibit-flow-rotation-schedule-${date.toISOString().slice(0, 10)}.csv`;
}

export function serializeRotationScheduleCsv(plan: RotationPlan): string {
  const lines: string[] = [
    ['Batch', 'Object', 'Sensitivity', 'Segment', 'Start', 'End', 'Zone', 'Object version', 'Zone version'].map(csvCell).join(','),
  ];
  for (const batch of plan.batches) {
    for (const dependency of batch.dependencies) {
      for (const stint of batch.stints) {
        lines.push([
          batch.label,
          dependency.artifactTitle,
          dependency.sensitivity,
          stint.kind,
          stint.startDate,
          stint.endDate,
          stint.zoneName ?? (stint.kind === 'rest' ? 'Conservation rest' : 'Unassigned'),
          dependency.artifactVersion,
          dependency.zoneVersion ?? '—',
        ].map(csvCell).join(','));
      }
    }
  }
  return lines.join('\r\n');
}

export function selectRotationArtifacts(state: WorkspaceState): Artifact[] {
  return state.artifacts.filter((artifact) => requiresRotation(artifact.sensitivity));
}

export function rotationStatusTone(status: RotationPlanStatus): 'positive' | 'warning' | 'neutral' {
  if (status === 'confirmed') return 'positive';
  if (status === 'review') return 'warning';
  return 'neutral';
}
