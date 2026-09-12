import { describe, expect, it } from 'vitest';
import { analyzeJourney } from './journeyAnalysis';
import { evaluateReadiness, buildSnapshot } from './reviewRules';
import { parseSnapshotResult, serializeSnapshot } from './export';
import { standardRuleProfile } from './ruleProfiles';
import { createSeedWorkspace } from '../state/seed';

describe('snapshot packages', () => {
  function readySnapshot() {
    const seed = createSeedWorkspace();
    const state = { ...seed, issues: seed.issues.map((issue) => ({ ...issue, status: 'resolved' as const })) };
    const rules = standardRuleProfile();
    const analysis = analyzeJourney(
      state.artifacts,
      state.zones,
      rules.parameters,
      { profileId: rules.profileId, version: rules.version, name: rules.name },
    );
    const readiness = evaluateReadiness(state, analysis, rules);
    return { state, rules, analysis, readiness, snapshot: buildSnapshot(state, analysis, readiness, rules) };
  }

  it('embeds the exact rule archive version in a schema v2 package', () => {
    const { readiness, snapshot } = readySnapshot();
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.ruleArchive).toEqual(readiness.ruleArchive);
    expect(snapshot.ruleProfile.profileId).toBe(snapshot.ruleArchive.profileId);
    expect(snapshot.ruleProfile.version).toBe(snapshot.ruleArchive.version);
  });

  it('round-trips and accepts a valid v2 package', () => {
    const { snapshot } = readySnapshot();
    const parsed = parseSnapshotResult(serializeSnapshot(snapshot));
    expect(parsed.status).toBe('valid');
    expect(parsed.snapshot?.ruleProfile.parameters.capacityWarnAt).toBe(0.8);
  });

  it('rejects a v2 package missing the embedded rule profile', () => {
    const { snapshot } = readySnapshot();
    const stripped = { ...snapshot, ruleProfile: undefined };
    const parsed = parseSnapshotResult(JSON.stringify(stripped));
    expect(parsed.status).toBe('invalid');
    expect(parsed.reason).toMatch(/readable rule archive/);
    expect(parsed.snapshot).toBeNull();
  });

  it('rejects a package whose reference does not match its embedded profile', () => {
    const { snapshot } = readySnapshot();
    const tampered = { ...snapshot, ruleArchive: { ...snapshot.ruleArchive, version: 9 } };
    const parsed = parseSnapshotResult(JSON.stringify(tampered));
    expect(parsed.status).toBe('invalid');
    expect(parsed.reason).toMatch(/does not match/);
  });

  it('labels pre-archive v1 packages as legacy instead of applying defaults', () => {
    const parsed = parseSnapshotResult(JSON.stringify({ schemaVersion: 1, project: {}, summary: {}, zones: [] }));
    expect(parsed.status).toBe('legacy-v1');
    expect(parsed.snapshot).toBeNull();
  });

  it('refuses to build a snapshot when readiness was computed under a different archive', () => {
    const seed = createSeedWorkspace();
    const state = { ...seed, issues: seed.issues.map((issue) => ({ ...issue, status: 'resolved' as const })) };
    const v1 = standardRuleProfile();
    const analysis = analyzeJourney(state.artifacts, state.zones, v1.parameters, { profileId: v1.profileId, version: 1, name: v1.name });
    const readiness = evaluateReadiness(state, analysis, v1);
    const v2 = { ...v1, version: 2 };
    expect(() => buildSnapshot(state, analysis, readiness, v2)).toThrow(/readiness was computed with standard-review-rules#1/);
  });
});
