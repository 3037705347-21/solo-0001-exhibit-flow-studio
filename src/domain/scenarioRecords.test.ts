import { describe, expect, it } from 'vitest';
import { analyzeJourney } from './journeyAnalysis';
import {
  computePlanVersion,
  createScenarioRecord,
  findDuplicateScenarioRecord,
  isRecordStale,
  normalizeScenarioName,
  scenarioInputSignature,
  validateScenarioRecordName,
} from './scenarioRecords';
import { createSeedWorkspace } from '../state/seed';
import type { WorkspaceState } from './models';

const fixedId = () => 'scenario-fixed';
const fixedDate = new Date('2026-09-10T10:00:00.000Z');

function buildRecord(
  state: WorkspaceState,
  name = 'Leisurely large group',
  input: { pace: 'focused' | 'balanced' | 'leisurely'; groupSize: number; accessibilityPriority: number } = { pace: 'leisurely', groupSize: 14, accessibilityPriority: 80 },
) {
  const result = createScenarioRecord(state, { name, input }, fixedId, fixedDate);
  if (!result.record) throw new Error(result.errors.map((error) => error.message).join('; '));
  return result.record;
}

describe('plan version fingerprint', () => {
  it('is stable across recomputation', () => {
    const state = createSeedWorkspace();
    expect(computePlanVersion(state.artifacts, state.zones)).toBe(computePlanVersion(state.artifacts, state.zones));
  });

  it('ignores zone ordering in the array', () => {
    const state = createSeedWorkspace();
    const reordered: WorkspaceState = { ...state, zones: [...state.zones].reverse() };
    expect(computePlanVersion(reordered.artifacts, reordered.zones)).toBe(computePlanVersion(state.artifacts, state.zones));
  });

  it('changes when a placement is removed', () => {
    const state = createSeedWorkspace();
    const before = computePlanVersion(state.artifacts, state.zones);
    const afterZones = state.zones.map((zone) =>
      zone.id === 'zone-arrival' ? { ...zone, artifactIds: [] } : zone,
    );
    expect(computePlanVersion(state.artifacts, afterZones)).not.toBe(before);
  });

  it('changes when an artifact dwell time changes', () => {
    const state = createSeedWorkspace();
    const before = computePlanVersion(state.artifacts, state.zones);
    const artifacts = state.artifacts.map((artifact) =>
      artifact.id === 'artifact-lantern' ? { ...artifact, dwellMinutes: 9 } : artifact,
    );
    expect(computePlanVersion(artifacts, state.zones)).not.toBe(before);
  });
});

describe('scenario record creation', () => {
  it('freezes inputs, plan version, projection and plan basis immutably', () => {
    const state = createSeedWorkspace();
    const record = buildRecord(state);
    expect(record.id).toBe('scenario-fixed');
    expect(record.input).toEqual({ pace: 'leisurely', groupSize: 14, accessibilityPriority: 80 });
    expect(record.planVersion).toBe(computePlanVersion(state.artifacts, state.zones));
    expect(record.projection.durationMinutes).toBeGreaterThan(0);
    expect(record.projection.recommendations.length).toBeGreaterThan(0);
    expect(record.planBasis).toEqual({
      artifactCount: state.artifacts.length,
      zoneCount: state.zones.length,
      placedCount: analyzeJourney(state.artifacts, state.zones).placedCount,
      totalDwellMinutes: analyzeJourney(state.artifacts, state.zones).totalDwellMinutes,
    });
    expect(record.createdAt).toBe(fixedDate.toISOString());
  });

  it('clamps out-of-range inputs at capture time', () => {
    const state = createSeedWorkspace();
    const record = buildRecord(state, 'Extremes', { pace: 'focused', groupSize: 99, accessibilityPriority: -5 });
    expect(record.input.groupSize).toBe(30);
    expect(record.input.accessibilityPriority).toBe(0);
  });

  it('does not mutate workspace state when building a record', () => {
    const state = createSeedWorkspace();
    const snapshot = JSON.stringify(state);
    buildRecord(state);
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it('rejects blank and over-long names', () => {
    expect(validateScenarioRecordName('   ', [])[0]?.field).toBe('name');
    expect(validateScenarioRecordName('x'.repeat(61), [])[0]?.field).toBe('name');
    expect(validateScenarioRecordName('x'.repeat(60), [])).toHaveLength(0);
  });

  it('normalizes internal whitespace', () => {
    expect(normalizeScenarioName('  Busy   Saturday  ')).toBe('Busy Saturday');
  });

  it('rejects duplicate names case-insensitively', () => {
    const state = createSeedWorkspace();
    const first = buildRecord(state, 'Weekend Crowd');
    const withRecord: WorkspaceState = { ...state, scenarioRecords: [first] };
    const result = createScenarioRecord(
      withRecord,
      { name: '  weekend crowd ', input: { pace: 'focused', groupSize: 2, accessibilityPriority: 10 } },
      fixedId,
      fixedDate,
    );
    expect(result.errors.map((error) => error.field)).toContain('name');
  });

  it('rejects the same inputs on the same plan version even under a different name', () => {
    const state = createSeedWorkspace();
    const first = buildRecord(state, 'First save');
    const withRecord: WorkspaceState = { ...state, scenarioRecords: [first] };
    const result = createScenarioRecord(
      withRecord,
      { name: 'Second save', input: { pace: 'leisurely', groupSize: 14, accessibilityPriority: 80 } },
      fixedId,
      fixedDate,
    );
    expect(result.errors.map((error) => error.field)).toContain('duplicate');
    expect(result.record).toBeUndefined();
  });

  it('allows the same inputs after the plan version changed', () => {
    const state = createSeedWorkspace();
    const first = buildRecord(state, 'Before the edit');
    const changedPlan: WorkspaceState = {
      ...state,
      zones: state.zones.map((zone) =>
        zone.id === 'zone-arrival' ? { ...zone, artifactIds: [] } : zone,
      ),
      scenarioRecords: [first],
    };
    const result = createScenarioRecord(
      changedPlan,
      { name: 'After the edit', input: { pace: 'leisurely', groupSize: 14, accessibilityPriority: 80 } },
      fixedId,
      fixedDate,
    );
    expect(result.errors).toHaveLength(0);
    expect(result.record).toBeDefined();
  });
});

describe('stale detection and signatures', () => {
  it('marks a record stale when the plan version differs', () => {
    const state = createSeedWorkspace();
    const record = buildRecord(state);
    const changedPlan: WorkspaceState = {
      ...state,
      artifacts: state.artifacts.map((artifact) =>
        artifact.id === 'artifact-lantern' ? { ...artifact, dwellMinutes: 2 } : artifact,
      ),
    };
    const currentVersion = computePlanVersion(changedPlan.artifacts, changedPlan.zones);
    expect(isRecordStale(record, currentVersion)).toBe(true);
    expect(isRecordStale(record, record.planVersion)).toBe(false);
  });

  it('treats clamped equivalent inputs as the same signature', () => {
    expect(scenarioInputSignature({ pace: 'balanced', groupSize: 12, accessibilityPriority: 40 }))
      .toBe(scenarioInputSignature({ pace: 'balanced', groupSize: 12.4, accessibilityPriority: 40.2 }));
  });

  it('finds duplicates by plan version and clamped input signature', () => {
    const state = createSeedWorkspace();
    const record = buildRecord(state);
    expect(findDuplicateScenarioRecord([record], { pace: 'leisurely', groupSize: 14, accessibilityPriority: 80 }, record.planVersion)).toBe(record);
    expect(findDuplicateScenarioRecord([record], { pace: 'leisurely', groupSize: 14, accessibilityPriority: 80 }, 'different-version')).toBeUndefined();
  });
});
