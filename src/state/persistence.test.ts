import { describe, expect, it } from 'vitest';
import { clearWorkspace, loadWorkspace, loadWorkspaceResult, rebindWorkspace, saveWorkspace, STORAGE_KEY } from './persistence';
import { createSeedWorkspace } from './seed';
import { STANDARD_PROFILE_ID } from '../domain/ruleProfiles';
import type { WorkspaceState } from '../domain/models';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } as unknown as Storage,
    values,
  };
}

describe('workspace persistence', () => {
  it('falls back to seed state for malformed storage', () => {
    const storage = { getItem: () => '{bad json' } as unknown as Storage;
    const result = loadWorkspaceResult(storage);
    expect(result.state.version).toBe(2);
    expect(result.problems).toContain('storage-malformed');
  });
  it('round trips a workspace through storage', () => {
    const { storage, values } = memoryStorage();
    const state = createSeedWorkspace();
    expect(saveWorkspace(state, storage)).toBe(true);
    expect(values.has(STORAGE_KEY)).toBe(true);
    expect(loadWorkspace(storage).project.title).toBe(state.project.title);
    clearWorkspace(storage);
    expect(values.has(STORAGE_KEY)).toBe(false);
  });
  it('migrates a v1 workspace by pinning it to standard rules v1', () => {
    const seed = createSeedWorkspace();
    const legacy = {
      version: 1,
      project: { ...seed.project },
      artifacts: seed.artifacts,
      zones: seed.zones,
      issues: seed.issues,
      preferences: seed.preferences,
    };
    delete (legacy.project as { ruleBinding?: unknown }).ruleBinding;
    const { storage } = memoryStorage({ [STORAGE_KEY]: JSON.stringify(legacy) });
    const result = loadWorkspaceResult(storage);
    expect(result.problems).toEqual([]);
    expect(result.state.version).toBe(2);
    expect(result.state.project.ruleBinding).toEqual({
      profileId: STANDARD_PROFILE_ID,
      version: 1,
      boundAt: new Date(0).toISOString(),
    });
    expect(result.state.ruleProfiles.some((profile) => profile.profileId === STANDARD_PROFILE_ID && profile.version === 1)).toBe(true);
  });
  it('never silently computes when the bound archive version is missing', () => {
    const seed = createSeedWorkspace();
    const broken: WorkspaceState = {
      ...seed,
      project: { ...seed.project, ruleBinding: { profileId: STANDARD_PROFILE_ID, version: 99, boundAt: new Date().toISOString() } },
    };
    const { storage } = memoryStorage({ [STORAGE_KEY]: JSON.stringify(broken) });
    const result = loadWorkspaceResult(storage);
    expect(result.problems).toContain('rule-profile-unknown');
    expect(result.state.project.ruleBinding?.version).toBe(99);
  });
  it('reports a missing binding instead of substituting defaults', () => {
    const seed = createSeedWorkspace();
    const unbound: WorkspaceState = {
      ...seed,
      project: { ...seed.project, ruleBinding: undefined },
    };
    const { storage } = memoryStorage({ [STORAGE_KEY]: JSON.stringify(unbound) });
    const result = loadWorkspaceResult(storage);
    expect(result.problems).toContain('rule-binding-missing');
  });
  it('can repair an unknown binding by rebinding to a locally present version', () => {
    const state = createSeedWorkspace();
    const broken: WorkspaceState = {
      ...state,
      project: { ...state.project, ruleBinding: { profileId: STANDARD_PROFILE_ID, version: 99, boundAt: new Date().toISOString() } },
    };
    expect(rebindWorkspace(broken, STANDARD_PROFILE_ID, 99)).toBeNull();
    const repaired = rebindWorkspace(broken, STANDARD_PROFILE_ID, 1);
    expect(repaired?.project.ruleBinding?.version).toBe(1);
  });
  it('filters structurally invalid profiles and reports it', () => {
    const seed = createSeedWorkspace();
    const tampered: WorkspaceState = {
      ...seed,
      ruleProfiles: [
        ...seed.ruleProfiles,
        { ...seed.ruleProfiles[0], version: 2, parameters: { ...seed.ruleProfiles[0].parameters, capacityWarnAt: 2 } },
      ],
    };
    const { storage } = memoryStorage({ [STORAGE_KEY]: JSON.stringify(tampered) });
    const result = loadWorkspaceResult(storage);
    expect(result.state.ruleProfiles).toHaveLength(1);
    expect(result.problems).toContain('profiles-filtered');
  });
});
