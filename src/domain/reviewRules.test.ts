import { describe, expect, it } from 'vitest';
import { analyzeJourney } from './journeyAnalysis';
import { evaluateReadiness } from './reviewRules';
import { standardRuleProfile } from './ruleProfiles';
import { createSeedWorkspace } from '../state/seed';

const rules = standardRuleProfile();

function evaluate(state: ReturnType<typeof createSeedWorkspace>) {
  const analysis = analyzeJourney(
    state.artifacts,
    state.zones,
    rules.parameters,
    { profileId: rules.profileId, version: rules.version, name: rules.name },
  );
  return evaluateReadiness(state, analysis, rules);
}

describe('readiness rules', () => {
  it('blocks a plan with an unresolved critical finding', () => {
    const state = createSeedWorkspace();
    const readiness = evaluate(state);
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.some((blocker) => blocker.includes('critical'))).toBe(true);
    expect(readiness.ruleArchive.version).toBe(1);
  });
  it('passes when the critical finding and all journey blockers are resolved', () => {
    const state = createSeedWorkspace();
    const clean = { ...state, issues: state.issues.map((issue) => ({ ...issue, status: 'resolved' as const })) };
    const readiness = evaluate(clean);
    expect(readiness.ready).toBe(true);
  });
});
