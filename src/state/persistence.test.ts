import { describe, expect, it } from 'vitest';
import { analyzeJourney } from '../domain/journeyAnalysis';
import { readinessDrift } from '../domain/readinessTracking';
import { evaluateReadiness } from '../domain/reviewRules';
import { clearWorkspace, loadWorkspace, saveWorkspace } from './persistence';
import { createSeedWorkspace } from './seed';

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } } as unknown as Storage;
}

describe('workspace persistence', () => {
  it('falls back to seed state for malformed storage', () => {
    const storage = { getItem: () => '{bad json' } as unknown as Storage;
    expect(loadWorkspace(storage).version).toBe(1);
  });
  it('round trips a workspace through storage', () => {
    const storage = memoryStorage();
    const state = createSeedWorkspace();
    expect(saveWorkspace(state, storage)).toBe(true);
    const loaded = loadWorkspace(storage);
    expect(loaded.project.title).toBe(state.project.title);
    expect(loaded.readiness).toBeUndefined();
    clearWorkspace(storage);
    expect(loadWorkspace(storage).project.title).toBe(state.project.title);
  });
  it('keeps the recorded readiness facts across a reload', () => {
    const storage = memoryStorage();
    const base = createSeedWorkspace();
    const readiness = evaluateReadiness(base, analyzeJourney(base.artifacts, base.zones));
    expect(saveWorkspace({ ...base, readiness }, storage)).toBe(true);
    const loaded = loadWorkspace(storage);
    expect(loaded.readiness?.ready).toBe(readiness.ready);
    expect(loaded.readiness?.facts).toEqual(readiness.facts);
    expect(readinessDrift(loaded)?.stale).toBe(false);
  });
  it('drops a malformed recorded readiness instead of crashing', () => {
    const storage = memoryStorage();
    const base = createSeedWorkspace();
    const legacy = { ...base, readiness: { ready: true, score: 100, blockers: ['old shape'], cautions: [], checkedAt: '2026-09-01T00:00:00.000Z' } };
    expect(saveWorkspace(legacy as unknown as Parameters<typeof saveWorkspace>[0], storage)).toBe(true);
    expect(loadWorkspace(storage).readiness).toBeUndefined();
  });
});
