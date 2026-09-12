import { describe, expect, it } from 'vitest';
import { createSeedWorkspace } from '../state/seed';
import { workspaceReducer } from '../state/reducer';
import {
  ROTATION_PROFILES,
  buildRotationPlan,
  buildRotationPlanExport,
  evaluateRotationPlan,
  moveArtifactToBatch,
  moveArtifactToNewBatch,
  reconcileRotationPlans,
  renameRotationBatch,
  rotationPlanFileName,
  selectRotationArtifacts,
  syncConfirmedPlan,
} from './rotation';
import type { Artifact, RotationPlan, WorkspaceState, Zone } from './models';

function seedWithPlan(): { state: WorkspaceState; plan: RotationPlan } {
  const initial = createSeedWorkspace();
  const plan = buildRotationPlan(initial);
  const generated = workspaceReducer(initial, { type: 'rotation/generate', plan });
  return { state: generated, plan };
}

function confirmPlan(state: WorkspaceState, planId: string): WorkspaceState {
  const confirmed = syncConfirmedPlan(state, planId);
  return workspaceReducer(state, {
    type: 'rotation/replace',
    plans: state.rotationPlans.map((plan) => (plan.id === planId ? confirmed : plan)),
  });
}

function artifactById(state: WorkspaceState, id: string): Artifact {
  const artifact = state.artifacts.find((candidate) => candidate.id === id);
  if (!artifact) throw new Error(`missing artifact ${id}`);
  return artifact;
}

describe('rotation plan generation', () => {
  it('creates one batch per sensitive object with alternating display and rest stints', () => {
    const state = createSeedWorkspace();
    const plan = buildRotationPlan(state);
    expect(plan.status).toBe('draft');
    const sensitiveIds = new Set(selectRotationArtifacts(state).map((artifact) => artifact.id));
    const covered = new Set(plan.batches.flatMap((batch) => batch.artifactIds));
    expect(covered).toEqual(sensitiveIds);
    for (const batch of plan.batches) {
      const profile = ROTATION_PROFILES[batch.rotationClass];
      expect(batch.displayDays).toBe(profile.displayDays);
      expect(batch.restDays).toBe(profile.restDays);
      expect(batch.stints.length).toBeGreaterThanOrEqual(4);
      expect(batch.stints[0].kind).toBe('display');
      expect(batch.stints[1].kind).toBe('rest');
      expect(batch.stints[0].startDate).toBe(state.project.openingDate);
      expect(batch.stints[0].loadMinutes).toBeGreaterThan(0);
      expect(batch.stints[1].loadMinutes).toBe(0);
      expect(batch.dependencies).toHaveLength(1);
      expect(batch.dependencies[0].artifactVersion).toMatch(/^[a-z0-9]+$/);
    }
  });

  it('flags sensitive objects placed in a normally lit gallery as a warning', () => {
    const state = createSeedWorkspace();
    const plan = buildRotationPlan(state);
    // The fragile bowl sits in zone-after, which is not a low-light zone.
    expect(plan.warnings.some((warning) => warning.includes('Mended Serving Bowl'))).toBe(true);
  });

  it('pins both object and zone versions on every dependency', () => {
    const state = createSeedWorkspace();
    const plan = buildRotationPlan(state);
    const quiltBatch = plan.batches.find((batch) => batch.artifactIds.includes('artifact-quilt'));
    expect(quiltBatch?.dependencies[0].zoneId).toBe('zone-common');
    expect(quiltBatch?.dependencies[0].zoneVersion).toBeTruthy();
  });
});

describe('manual batch adjustments', () => {
  it('renames a batch, marks it manual, and returns the plan to draft', () => {
    const { state, plan } = seedWithPlan();
    const confirmed = confirmPlan(state, plan.id);
    expect(confirmed.rotationPlans[0].status).toBe('confirmed');
    const batchId = plan.batches[0].id;
    const plans = renameRotationBatch(confirmed, plan.id, batchId, '  Textile group A  ');
    expect(plans[0].status).toBe('draft');
    const batch = plans[0].batches.find((candidate) => candidate.id === batchId);
    expect(batch?.label).toBe('Textile group A');
    expect(batch?.manual).toBe(true);
  });

  it('moves an object into a same-class batch and rebuilds combined stints', () => {
    const { state, plan } = seedWithPlan();
    // Quilt and sample book are both low-light; move the quilt into the book's batch.
    const target = plan.batches.find((batch) => batch.artifactIds.includes('artifact-sample-book'))!;
    const plans = moveArtifactToBatch(state, plan.id, 'artifact-quilt', null, target.id);
    const merged = plans[0].batches.find((batch) => batch.id === target.id)!;
    expect(merged.artifactIds).toContain('artifact-quilt');
    expect(merged.artifactIds).toContain('artifact-sample-book');
    expect(merged.dependencies).toHaveLength(2);
    expect(merged.manual).toBe(true);
    // Combined load uses both dwell times.
    expect(merged.stints[0].loadMinutes).toBe((6 + 8) * merged.displayDays);
    // Single-object source batch is removed after the move.
    expect(plans[0].batches.some((batch) => batch.artifactIds.includes('artifact-quilt') && !batch.artifactIds.includes('artifact-sample-book'))).toBe(false);
    expect(plans[0].status).toBe('draft');
  });

  it('moves an object into a new batch of the matching class', () => {
    const { state, plan } = seedWithPlan();
    const before = plan.batches.length;
    const plans = moveArtifactToNewBatch(state, plan.id, 'artifact-bowl', plan.batches.find((batch) => batch.artifactIds.includes('artifact-bowl'))!.id);
    expect(plans[0].batches).toHaveLength(before); // source was a single-object batch and is replaced
    const bowlBatch = plans[0].batches.find((batch) => batch.artifactIds.includes('artifact-bowl'))!;
    expect(bowlBatch.rotationClass).toBe('fragile');
    expect(bowlBatch.manual).toBe(true);
    expect(plans[0].status).toBe('draft');
  });

  it('refuses to merge objects whose sensitivity classes differ', () => {
    const { state, plan } = seedWithPlan();
    const fragileBatch = plan.batches.find((batch) => batch.rotationClass === 'fragile')!;
    expect(() => moveArtifactToBatch(state, plan.id, 'artifact-quilt', null, fragileBatch.id)).toThrow(/fragile batch/);
  });
});

describe('object sensitivity changes', () => {
  it('drops a confirmed plan to review when an object sensitivity changes', () => {
    const { state, plan } = seedWithPlan();
    const confirmedState = confirmPlan(state, plan.id);
    const bowl = artifactById(confirmedState, 'artifact-bowl');
    const updated: Artifact = { ...bowl, sensitivity: 'low-light', updatedAt: new Date().toISOString() };
    const changed = workspaceReducer(confirmedState, { type: 'artifact/upsert', artifact: updated });
    const stored = changed.rotationPlans[0];
    expect(stored.status).toBe('review');
    expect(stored.reviewReasons.join(' ')).toMatch(/Mended Serving Bowl|batch/i);
    const health = evaluateRotationPlan(changed, stored);
    expect(health.status).toBe('review');
    expect(health.staleBatchIds.length + health.missingBatchIds.length).toBeGreaterThan(0);
  });

  it('treats a newly sensitive but uncovered object as a confirm blocker', () => {
    const { state, plan } = seedWithPlan();
    const confirmedState = confirmPlan(state, plan.id);
    const lantern = artifactById(confirmedState, 'artifact-lantern');
    const updated: Artifact = { ...lantern, sensitivity: 'fragile', updatedAt: new Date().toISOString() };
    const changed = workspaceReducer(confirmedState, { type: 'artifact/upsert', artifact: updated });
    const health = evaluateRotationPlan(changed, changed.rotationPlans[0]);
    expect(health.canConfirm).toBe(false);
    expect(health.uncoveredSensitive).toContain('Railway Signal Lantern');
    expect(() => syncConfirmedPlan(changed, plan.id)).toThrow(/Railway Signal Lantern/);
  });

  it('removing an object forces the affected batch into a missing, unconfirmable state', () => {
    const { state, plan } = seedWithPlan();
    const confirmedState = confirmPlan(state, plan.id);
    const changed = workspaceReducer(confirmedState, { type: 'artifact/remove', artifactId: 'artifact-quilt' });
    const health = evaluateRotationPlan(changed, changed.rotationPlans[0]);
    expect(health.status).toBe('review');
    expect(health.canConfirm).toBe(false);
    expect(health.reasons.join(' ')).toMatch(/removed|missing/i);
  });

  it('recovers by regenerating a plan against the new data', () => {
    const { state, plan } = seedWithPlan();
    const confirmedState = confirmPlan(state, plan.id);
    const bowl = artifactById(confirmedState, 'artifact-bowl');
    const changed = workspaceReducer(confirmedState, {
      type: 'artifact/upsert',
      artifact: { ...bowl, sensitivity: 'low-light', updatedAt: new Date().toISOString() },
    });
    const regenerated = buildRotationPlan(changed);
    const withRegenerated = workspaceReducer(changed, { type: 'rotation/generate', plan: regenerated });
    const recovered = confirmPlan(withRegenerated, regenerated.id);
    expect(recovered.rotationPlans.find((candidate) => candidate.id === regenerated.id)?.status).toBe('confirmed');
  });
});

describe('zone condition changes', () => {
  it('drops dependent batches to review when a zone light level changes', () => {
    const { state, plan } = seedWithPlan();
    const confirmedState = confirmPlan(state, plan.id);
    const common = confirmedState.zones.find((zone) => zone.id === 'zone-common')!;
    const changedZone: Zone = { ...common, lowLight: false };
    const changed = workspaceReducer(confirmedState, { type: 'zone/update', zone: changedZone });
    const stored = changed.rotationPlans[0];
    expect(stored.status).toBe('review');
    const health = evaluateRotationPlan(changed, stored);
    const staleBatch = health.batches.find((batch) => batch.state === 'stale');
    expect(staleBatch).toBeTruthy();
    expect(staleBatch?.reasons.join(' ')).toMatch(/lighting|gallery/i);
  });

  it('moving an object to another gallery invalidates its pinned zone version', () => {
    const { state, plan } = seedWithPlan();
    const confirmedState = confirmPlan(state, plan.id);
    const changed = workspaceReducer(confirmedState, {
      type: 'placement/assign',
      artifactId: 'artifact-quilt',
      zoneId: 'zone-after',
    });
    const health = evaluateRotationPlan(changed, changed.rotationPlans[0]);
    expect(health.status).toBe('review');
    const movedBatch = health.batches
      .find((batch) => batch.reasons.some((reason) => reason.includes('moved from')));
    expect(movedBatch).toBeTruthy();
  });

  it('re-confirms after restoring the zone, re-pinning versions', () => {
    const { state, plan } = seedWithPlan();
    const confirmedState = confirmPlan(state, plan.id);
    const common = confirmedState.zones.find((zone) => zone.id === 'zone-common')!;
    const changed = workspaceReducer(confirmedState, { type: 'zone/update', zone: { ...common, lowLight: false } });
    const restored = workspaceReducer(changed, { type: 'zone/update', zone: common });
    // Fingerprint matches again; reconciliation should leave the plan... it was
    // marked review on the first change and reconciliation only re-evaluates
    // stored review plans (stays review until a human re-confirms), which
    // syncConfirmedPlan now allows because versions match.
    const recovered = confirmPlan(restored, plan.id);
    expect(recovered.rotationPlans[0].status).toBe('confirmed');
    expect(recovered.rotationPlans[0].reviewReasons).toEqual([]);
  });
});

describe('opening date changes', () => {
  it('marks confirmed plans for review and shifts stints on re-confirm', () => {
    const { state, plan } = seedWithPlan();
    const confirmedState = confirmPlan(state, plan.id);
    const changed = workspaceReducer(confirmedState, { type: 'project/openingDate', openingDate: '2027-05-01' });
    expect(changed.rotationPlans[0].status).toBe('review');
    const health = evaluateRotationPlan(changed, changed.rotationPlans[0]);
    expect(health.openingDateMismatch).toBe(true);
    expect(health.canConfirm).toBe(true);
    const recovered = confirmPlan(changed, plan.id);
    const reconfirmed = recovered.rotationPlans[0];
    expect(reconfirmed.status).toBe('confirmed');
    expect(reconfirmed.openingDate).toBe('2027-05-01');
    expect(reconfirmed.batches[0].stints[0].startDate).toBe('2027-05-01');
  });
});

describe('recovery and export', () => {
  it('re-pins every dependency version when a review plan is re-confirmed', () => {
    const { state, plan } = seedWithPlan();
    const confirmedState = confirmPlan(state, plan.id);
    const oldVersion = confirmedState.rotationPlans[0].batches[0].dependencies[0].artifactVersion;
    const quilt = artifactById(confirmedState, 'artifact-quilt');
    const changed = workspaceReducer(confirmedState, {
      type: 'artifact/upsert',
      artifact: { ...quilt, dwellMinutes: 9, updatedAt: new Date().toISOString() },
    });
    const reConfirmedState = confirmPlan(changed, plan.id);
    const quiltBatch = reConfirmedState.rotationPlans[0].batches.find((batch) => batch.artifactIds.includes('artifact-quilt'))!;
    expect(quiltBatch.dependencies[0].artifactVersion).not.toBe(oldVersion);
  });

  it('exports the effective review status even when stored status is stale', () => {
    const { state, plan } = seedWithPlan();
    const confirmedState = confirmPlan(state, plan.id);
    const common = confirmedState.zones.find((zone) => zone.id === 'zone-common')!;
    const changed = workspaceReducer(confirmedState, { type: 'zone/update', zone: { ...common, lowLight: false } });
    const exported = buildRotationPlanExport(changed, changed.rotationPlans[0]);
    expect(exported.planStatus).toBe('review');
    expect(exported.batches.some((batch) => batch.state === 'stale')).toBe(true);
    expect(rotationPlanFileName(new Date('2027-01-02T00:00:00Z'))).toBe('exhibit-flow-rotation-2027-01-02.json');
  });

  it('reconciliation is idempotent and leaves a current confirmed plan confirmed', () => {
    const { state, plan } = seedWithPlan();
    const confirmedState = confirmPlan(state, plan.id);
    const once = reconcileRotationPlans(confirmedState);
    const twice = reconcileRotationPlans({ ...confirmedState, rotationPlans: once });
    expect(twice[0].status).toBe('confirmed');
  });
});
