import { describe, expect, it } from 'vitest';
import {
  STANDARD_PROFILE_ID,
  cloneParameters,
  diffRuleParameters,
  draftNextVersion,
  explainRuleProfile,
  isRuleProfile,
  nextVersionNumber,
  profileKey,
  resolveRuleProfile,
  standardRuleProfile,
} from './ruleProfiles';
import type { WorkspaceState } from './models';
import { createSeedWorkspace } from '../state/seed';

describe('rule profiles', () => {
  it('ships an immutable standard v1 that matches the historical hard-coded thresholds', () => {
    const profile = standardRuleProfile();
    expect(profile.profileId).toBe(STANDARD_PROFILE_ID);
    expect(profile.version).toBe(1);
    expect(profile.parameters.capacityWarnAt).toBe(0.8);
    expect(profile.parameters.capacityBlockAt).toBe(1);
    expect(profile.parameters.blockingRole).toBe('turning-point');
    expect(isRuleProfile(profile)).toBe(true);
    expect(explainRuleProfile(profile).length).toBeGreaterThan(6);
  });

  it('drafts the next monotonic version without mutating the basis', () => {
    const v1 = standardRuleProfile();
    const parameters = cloneParameters(v1.parameters);
    parameters.capacityWarnAt = 0.7;
    const v2 = draftNextVersion([v1], v1, { parameters, changeSummary: 'Tighter warning line.' });
    expect(v2.version).toBe(2);
    expect(v1.parameters.capacityWarnAt).toBe(0.8);
    expect(nextVersionNumber([v1, v2], v1.profileId)).toBe(3);
  });

  it('rejects structurally invalid profiles', () => {
    const v1 = standardRuleProfile();
    expect(isRuleProfile(null)).toBe(false);
    expect(isRuleProfile({ ...v1, version: 0 })).toBe(false);
    expect(isRuleProfile({ ...v1, parameters: { ...v1.parameters, capacityWarnAt: 1.5 } })).toBe(false);
    expect(isRuleProfile({ ...v1, parameters: { ...v1.parameters, capacityWarnAt: 0.9, capacityBlockAt: 0.5 } })).toBe(false);
  });

  it('diffs parameter changes for display', () => {
    const v1 = standardRuleProfile();
    const parameters = cloneParameters(v1.parameters);
    parameters.seatingSeverity = 'error';
    const changes = diffRuleParameters(v1.parameters, parameters);
    expect(changes.some((change) => change.key === 'seatingSeverity')).toBe(true);
  });

  it('resolves the bound archive and fails explicitly on missing/unknown versions', () => {
    const state: WorkspaceState = createSeedWorkspace();
    expect(resolveRuleProfile(state).status).toBe('resolved');
    expect(profileKey(STANDARD_PROFILE_ID, 1)).toBe(`${STANDARD_PROFILE_ID}#1`);

    const unbound = { ...state, project: { ...state.project, ruleBinding: undefined } };
    expect(resolveRuleProfile(unbound).status).toBe('binding-missing');

    const unknownVersion = {
      ...state,
      project: { ...state.project, ruleBinding: { profileId: STANDARD_PROFILE_ID, version: 42, boundAt: new Date().toISOString() } },
    };
    const resolution = resolveRuleProfile(unknownVersion);
    expect(resolution.status).toBe('profile-unknown');
    expect(resolution.reason).toContain('42');

    const unknownLine = {
      ...state,
      project: { ...state.project, ruleBinding: { profileId: 'other-rules', version: 1, boundAt: new Date().toISOString() } },
    };
    expect(resolveRuleProfile(unknownLine).status).toBe('profile-unknown');
  });
});
