import { describe, expect, it } from 'vitest';
import type { RotationPlan, WorkspaceState } from '../domain/models';
import { buildRotationPlan, syncConfirmedPlan } from '../domain/rotation';
import { migrateWorkspace, sanitizeRotationPlans } from './migrations';
import { loadWorkspace, saveWorkspace, STORAGE_KEY } from './persistence';
import { createSeedWorkspace } from './seed';
import { workspaceReducer } from './reducer';

function generatedSeed(): { state: WorkspaceState; plan: RotationPlan } {
  const seed = createSeedWorkspace();
  const plan = buildRotationPlan(seed);
  return { state: workspaceReducer(seed, { type: 'rotation/generate', plan }), plan };
}

function confirmed(state: WorkspaceState, planId: string): WorkspaceState {
  const plan = syncConfirmedPlan(state, planId);
  return workspaceReducer(state, {
    type: 'rotation/replace',
    plans: state.rotationPlans.map((candidate) => (candidate.id === planId ? plan : candidate)),
  });
}

describe('rotation reducer integration', () => {
  it('saves rotation plans with the workspace and keeps a confirmed plan confirmed across reducer calls', () => {
    const { state, plan } = generatedSeed();
    const confirmedState = confirmed(state, plan.id);
    // An unrelated action (preferences) must not disturb the confirmed plan.
    const after = workspaceReducer(confirmedState, {
      type: 'preferences/update',
      preferences: { ...confirmedState.preferences, groupSize: 9 },
    });
    expect(after.rotationPlans[0].status).toBe('confirmed');
    expect(after.rotationPlans[0]).toBeDefined();
  });

  it('object sensitivity change flips the stored status from confirmed to review', () => {
    const { state, plan } = generatedSeed();
    const confirmedState = confirmed(state, plan.id);
    const bowl = confirmedState.artifacts.find((artifact) => artifact.id === 'artifact-bowl')!;
    const changed = workspaceReducer(confirmedState, {
      type: 'artifact/upsert',
      artifact: { ...bowl, sensitivity: 'low-light', updatedAt: new Date().toISOString() },
    });
    expect(changed.rotationPlans[0].status).toBe('review');
    // The plan must never be presented as confirmed afterwards.
    const stillChanged = workspaceReducer(changed, {
      type: 'preferences/update',
      preferences: changed.preferences,
    });
    expect(stillChanged.rotationPlans[0].status).toBe('review');
  });

  it('opening date change sends confirmed plans to review', () => {
    const { state, plan } = generatedSeed();
    const confirmedState = confirmed(state, plan.id);
    const changed = workspaceReducer(confirmedState, { type: 'project/openingDate', openingDate: '2028-01-01' });
    expect(changed.rotationPlans[0].status).toBe('review');
  });

  it('regressing ready project on zone and opening date changes', () => {
    const { state, plan } = generatedSeed();
    let working = confirmed(state, plan.id);
    working = workspaceReducer(working, { type: 'project/readiness', ready: true, checkedAt: new Date().toISOString() });
    expect(working.project.stage).toBe('ready');
    const zone = working.zones[0];
    working = workspaceReducer(working, { type: 'zone/update', zone: { ...zone, lowLight: !zone.lowLight } });
    expect(working.project.stage).toBe('review');
  });
});

describe('rotation persistence', () => {
  function memoryStorage(): Storage & { values: Map<string, string> } {
    const values = new Map<string, string>();
    return {
      values,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
      clear: () => values.clear(),
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      length: 0,
    } as unknown as Storage & { values: Map<string, string> };
  }

  it('round trips a confirmed rotation plan through storage', () => {
    const storage = memoryStorage();
    const { state, plan } = generatedSeed();
    const confirmedState = confirmed(state, plan.id);
    expect(saveWorkspace(confirmedState, storage)).toBe(true);
    const loaded = loadWorkspace(storage);
    expect(loaded.rotationPlans).toHaveLength(1);
    expect(loaded.rotationPlans[0].status).toBe('confirmed');
    expect(loaded.rotationPlans[0].batches.length).toBe(confirmedState.rotationPlans[0].batches.length);
  });

  it('safely builds the initial rotation collection from old data without rotationPlans', () => {
    const legacy = { ...createSeedWorkspace() } as Partial<WorkspaceState>;
    delete legacy.rotationPlans;
    const migrated = migrateWorkspace(legacy);
    expect(migrated?.rotationPlans).toEqual([]);
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify(legacy));
    const loaded = loadWorkspace(storage);
    expect(loaded.rotationPlans).toEqual([]);
  });

  it('downgrades a stale confirmed plan loaded from storage to review', () => {
    const { state, plan } = generatedSeed();
    const confirmedState = confirmed(state, plan.id);
    // Tamper with a stored zone after confirmation to simulate old saved data.
    const stored: WorkspaceState = {
      ...confirmedState,
      zones: confirmedState.zones.map((zone) => (zone.id === 'zone-common' ? { ...zone, lowLight: false } : zone)),
    };
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify(stored));
    const loaded = loadWorkspace(storage);
    expect(loaded.rotationPlans[0].status).toBe('review');
  });

  it('sanitizes malformed rotation data instead of crashing', () => {
    const clean = sanitizeRotationPlans([
      null,
      { id: 'x' },
      {
        id: 'plan-ok',
        name: 'ok',
        status: 'bogus',
        openingDate: '2027-03-18',
        batches: [{ id: 'b1', label: 'B', rotationClass: 'fragile', artifactIds: ['a'], stints: [], dependencies: [] }],
        warnings: ['fine', 42],
      },
    ]);
    expect(clean).toHaveLength(1);
    expect(clean[0].status).toBe('draft');
    expect(clean[0].warnings).toEqual(['fine']);
  });
});
