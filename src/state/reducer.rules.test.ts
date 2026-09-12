import { describe, expect, it } from 'vitest';
import { workspaceReducer } from './reducer';
import { createSeedWorkspace } from './seed';
import { cloneParameters, draftNextVersion, standardRuleProfile } from '../domain/ruleProfiles';
import type { ReadinessRun, RuleProfile } from '../domain/models';

function publish(state: ReturnType<typeof createSeedWorkspace>, changeSummary: string, patch?: (parameters: RuleProfile['parameters']) => void): RuleProfile {
  const basis = state.ruleProfiles.find((profile) => profile.profileId === standardRuleProfile().profileId && profile.version === state.project.ruleBinding!.version)
    ?? state.ruleProfiles[0];
  const parameters = cloneParameters(basis.parameters);
  patch?.(parameters);
  return draftNextVersion(state.ruleProfiles, basis, { parameters, changeSummary });
}

describe('rule archive reducer', () => {
  it('appends published versions without mutating older ones', () => {
    const initial = createSeedWorkspace();
    const v2 = publish(initial, 'Tighter warnings', (parameters) => { parameters.capacityWarnAt = 0.7; });
    const next = workspaceReducer(initial, { type: 'rules/publish', profile: v2 });
    expect(next.ruleProfiles).toHaveLength(2);
    expect(initial.ruleProfiles).toHaveLength(1);
    expect(initial.ruleProfiles[0].parameters.capacityWarnAt).toBe(0.8);
    expect(next.project.ruleBinding?.version).toBe(1);
    expect(() => workspaceReducer(next, { type: 'rules/publish', profile: v2 })).toThrow(/immutable/);
  });

  it('switches the binding and regresses a ready project', () => {
    let state = createSeedWorkspace();
    const run: ReadinessRun = {
      id: 'run-1',
      checkedAt: new Date().toISOString(),
      ready: true,
      score: 100,
      blockers: [],
      cautions: [],
      ruleArchive: { profileId: state.project.ruleBinding!.profileId, version: 1, name: 'Standard' },
    };
    state = workspaceReducer(state, { type: 'project/readiness', ready: true, checkedAt: run.checkedAt, run });
    expect(state.project.stage).toBe('ready');
    expect(state.readinessRuns[0].ruleArchive.version).toBe(1);

    const v2 = publish(state, 'Looser rules', (parameters) => { parameters.capacityWarnAt = 0.95; });
    state = workspaceReducer(state, { type: 'rules/publish', profile: v2 });
    state = workspaceReducer(state, {
      type: 'rules/bind',
      binding: { profileId: v2.profileId, version: v2.version, boundAt: new Date().toISOString() },
    });
    expect(state.project.ruleBinding?.version).toBe(2);
    expect(state.project.stage).toBe('review');
  });

  it('refuses to bind to an archive version that is not stored locally', () => {
    const state = createSeedWorkspace();
    expect(() => workspaceReducer(state, {
      type: 'rules/bind',
      binding: { profileId: 'standard-review-rules', version: 77, boundAt: new Date().toISOString() },
    })).toThrow(/not stored/);
  });

  it('records every readiness run against the archive version used', () => {
    let state = createSeedWorkspace();
    const makeRun = (version: number, ready: boolean): ReadinessRun => ({
      id: `run-${version}`,
      checkedAt: new Date().toISOString(),
      ready,
      score: ready ? 90 : 40,
      blockers: ready ? []: ['x'],
      cautions: [],
      ruleArchive: { profileId: 'standard-review-rules', version, name: 'Standard gallery review rules' },
    });
    state = workspaceReducer(state, { type: 'project/readiness', ready: false, checkedAt: new Date().toISOString(), run: makeRun(1, false) });
    const v2 = publish(state, 'v2', (parameters) => { parameters.capacityWarnAt = 0.9; });
    state = workspaceReducer(state, { type: 'rules/publish', profile: v2 });
    state = workspaceReducer(state, {
      type: 'rules/bind',
      binding: { profileId: v2.profileId, version: 2, boundAt: new Date().toISOString() },
    });
    state = workspaceReducer(state, { type: 'project/readiness', ready: true, checkedAt: new Date().toISOString(), run: makeRun(2, true) });
    expect(state.readinessRuns.map((run) => `${run.ruleArchive.version}:${run.ready}`)).toEqual(['2:true', '1:false']);
  });
});
