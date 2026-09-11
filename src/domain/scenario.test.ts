import { describe, expect, it } from 'vitest';
import { analyzeJourney } from './journeyAnalysis';
import { clampScenario, projectScenario } from './scenario';
import { createSeedWorkspace } from '../state/seed';

describe('scenario projection', () => {
  it('clamps visitor inputs', () => {
    expect(clampScenario({ pace: 'balanced', accessibilityPriority: 200, groupSize: 0, targetVisitMinutes: null })).toEqual({ pace: 'balanced', accessibilityPriority: 100, groupSize: 1, targetVisitMinutes: null });
    expect(clampScenario({ pace: 'balanced', accessibilityPriority: 50, groupSize: 4, targetVisitMinutes: 999 })).toEqual({ pace: 'balanced', accessibilityPriority: 50, groupSize: 4, targetVisitMinutes: 240 });
  });
  it('derives recommendations without mutating state', () => {
    const state = createSeedWorkspace();
    const before = JSON.stringify(state.preferences);
    const projection = projectScenario(state, analyzeJourney(state.artifacts, state.zones), { pace: 'leisurely', accessibilityPriority: 90, groupSize: 18, targetVisitMinutes: null });
    expect(projection.durationMinutes).toBeGreaterThan(0);
    expect(projection.recommendations.length).toBeGreaterThan(0);
    expect(JSON.stringify(state.preferences)).toBe(before);
  });
});
