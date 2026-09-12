import { describe, expect, it } from 'vitest';
import { workspaceReducer } from './reducer';
import { createSeedWorkspace } from './seed';

describe('preferences/update', () => {
  it('applies new planning preferences and stamps the save time', () => {
    const state = createSeedWorkspace();
    const next = workspaceReducer(state, { type: 'preferences/update', preferences: { pace: 'focused', accessibilityPriority: 20, groupSize: 3 } });
    expect(next.preferences).toEqual({ pace: 'focused', accessibilityPriority: 20, groupSize: 3 });
    expect(next.lastSavedAt).not.toBe(state.lastSavedAt);
  });

  it('ignores identical writes so repeated submissions do not duplicate updates', () => {
    const state = createSeedWorkspace();
    const once = workspaceReducer(state, { type: 'preferences/update', preferences: { pace: 'focused', accessibilityPriority: 20, groupSize: 3 } });
    const twice = workspaceReducer(once, { type: 'preferences/update', preferences: { pace: 'focused', accessibilityPriority: 20, groupSize: 3 } });
    expect(twice).toBe(once);
    expect(twice.lastSavedAt).toBe(once.lastSavedAt);
  });
});
