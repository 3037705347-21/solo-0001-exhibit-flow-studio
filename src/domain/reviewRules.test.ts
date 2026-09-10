import { describe, expect, it } from 'vitest';
import { analyzeJourney } from './journeyAnalysis';
import { evaluateReadiness } from './reviewRules';
import { createSeedWorkspace } from '../state/seed';

describe('readiness rules', () => {
  it('blocks a plan with an unresolved critical finding', () => {
    const state = createSeedWorkspace();
    const readiness = evaluateReadiness(state, analyzeJourney(state.artifacts, state.zones));
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.some((blocker) => blocker.includes('critical'))).toBe(true);
  });
  it('passes when the critical finding and all journey blockers are resolved', () => {
    const state = createSeedWorkspace();
    const clean = { ...state, issues: state.issues.map((issue) => ({ ...issue, status: 'resolved' as const })) };
    const readiness = evaluateReadiness(clean, analyzeJourney(clean.artifacts, clean.zones));
    expect(readiness.ready).toBe(true);
  });
});
