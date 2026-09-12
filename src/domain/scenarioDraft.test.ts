import { describe, expect, it } from 'vitest';
import { createSeedWorkspace } from '../state/seed';
import type { PlanningPreferences } from './models';
import {
  diffPreferences,
  hasDraftChanges,
  isValidScenarioDraft,
  isValidScenarioInput,
  planVersion,
  resolveScenarioDraft,
  scenarioDraftStatus,
  type ScenarioDraft,
} from './scenarioDraft';

const saved: PlanningPreferences = { pace: 'balanced', accessibilityPriority: 70, groupSize: 6 };

function draftWith(changes: Partial<PlanningPreferences>, baseVersion = 'plan-base'): ScenarioDraft {
  return { changes, updatedAt: '2026-09-12T10:30:00.000Z', baseVersion };
}

describe('planVersion', () => {
  it('is stable for the same plan and ignores preferences, issues, and save metadata', () => {
    const state = createSeedWorkspace();
    const version = planVersion(state);
    expect(planVersion(state)).toBe(version);
    expect(planVersion({ ...state, preferences: { pace: 'focused', accessibilityPriority: 5, groupSize: 2 } })).toBe(version);
    expect(planVersion({ ...state, issues: [] })).toBe(version);
    expect(planVersion({ ...state, lastSavedAt: '2030-01-01T00:00:00.000Z' })).toBe(version);
  });

  it('changes when artifacts, zones, or placements change', () => {
    const state = createSeedWorkspace();
    const version = planVersion(state);
    const placed = {
      ...state,
      zones: state.zones.map((zone, index) => (index === 0 ? { ...zone, artifactIds: [...zone.artifactIds, 'artifact-gloves'] } : zone)),
    };
    expect(planVersion(placed)).not.toBe(version);
    const edited = {
      ...state,
      artifacts: state.artifacts.map((artifact, index) => (index === 0 ? { ...artifact, dwellMinutes: artifact.dwellMinutes + 1 } : artifact)),
    };
    expect(planVersion(edited)).not.toBe(version);
  });
});

describe('diffPreferences', () => {
  it('records only the values that differ from the saved preferences', () => {
    expect(diffPreferences(saved, { ...saved, pace: 'leisurely' })).toEqual({ pace: 'leisurely' });
    expect(diffPreferences(saved, { pace: 'focused', accessibilityPriority: 90, groupSize: 6 })).toEqual({ pace: 'focused', accessibilityPriority: 90 });
    expect(diffPreferences(saved, saved)).toEqual({});
  });
});

describe('resolveScenarioDraft', () => {
  it('replays the stored delta on top of the saved preferences', () => {
    const draft = draftWith({ pace: 'focused', groupSize: 12 });
    expect(resolveScenarioDraft(saved, draft)).toEqual({ pace: 'focused', accessibilityPriority: 70, groupSize: 12 });
    expect(hasDraftChanges(draft)).toBe(true);
    expect(hasDraftChanges(draftWith({}))).toBe(false);
  });
});

describe('isValidScenarioDraft', () => {
  it('accepts a well-formed draft', () => {
    expect(isValidScenarioDraft(draftWith({ pace: 'leisurely', accessibilityPriority: 20, groupSize: 4 }))).toBe(true);
    expect(isValidScenarioDraft(draftWith({}))).toBe(true);
  });

  it('rejects malformed or out-of-range drafts', () => {
    expect(isValidScenarioDraft(null)).toBe(false);
    expect(isValidScenarioDraft('draft')).toBe(false);
    expect(isValidScenarioDraft({ ...draftWith({}), updatedAt: 'not-a-date' })).toBe(false);
    expect(isValidScenarioDraft({ ...draftWith({}), baseVersion: 42 })).toBe(false);
    expect(isValidScenarioDraft(draftWith({ pace: 'warp-speed' as PlanningPreferences['pace'] }))).toBe(false);
    expect(isValidScenarioDraft(draftWith({ groupSize: 99 }))).toBe(false);
    expect(isValidScenarioDraft(draftWith({ accessibilityPriority: -5 }))).toBe(false);
    expect(isValidScenarioDraft({ ...draftWith({}), changes: { theme: 'dark' } })).toBe(false);
  });
});

describe('isValidScenarioInput', () => {
  it('accepts in-range scenario values', () => {
    expect(isValidScenarioInput({ pace: 'balanced', accessibilityPriority: 0, groupSize: 1 })).toBe(true);
    expect(isValidScenarioInput({ pace: 'leisurely', accessibilityPriority: 100, groupSize: 30 })).toBe(true);
  });

  it('rejects values that could not be written safely', () => {
    expect(isValidScenarioInput({ pace: 'balanced', accessibilityPriority: 101, groupSize: 6 })).toBe(false);
    expect(isValidScenarioInput({ pace: 'balanced', accessibilityPriority: 50, groupSize: 0 })).toBe(false);
    expect(isValidScenarioInput({ pace: 'hyper', accessibilityPriority: 50, groupSize: 6 })).toBe(false);
    expect(isValidScenarioInput(undefined)).toBe(false);
  });
});

describe('scenarioDraftStatus', () => {
  it('is ready on the matching plan version and stale otherwise', () => {
    const state = createSeedWorkspace();
    const ready = draftWith({ pace: 'focused' }, planVersion(state));
    expect(scenarioDraftStatus(ready, state)).toBe('ready');
    expect(scenarioDraftStatus(draftWith({ pace: 'focused' }, 'plan-earlier'), state)).toBe('stale');
  });
});
