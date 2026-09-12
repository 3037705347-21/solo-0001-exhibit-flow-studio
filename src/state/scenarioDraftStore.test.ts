import { describe, expect, it } from 'vitest';
import type { ScenarioDraft } from '../domain/scenarioDraft';
import { clearScenarioDraft, loadScenarioDraft, saveScenarioDraft, SCENARIO_DRAFT_KEY } from './scenarioDraftStore';

interface MemoryStorage extends Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  has: (key: string) => boolean;
}

function memoryStorage(initial: Record<string, string> = {}): MemoryStorage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    has: (key: string) => values.has(key),
  };
}

const draft: ScenarioDraft = {
  changes: { pace: 'leisurely', groupSize: 12 },
  updatedAt: '2026-09-12T10:30:00.000Z',
  baseVersion: 'plan-9f2c1a00',
};

describe('scenario draft store', () => {
  it('round trips a draft through storage and clears it', () => {
    const storage = memoryStorage();
    expect(saveScenarioDraft(draft, storage)).toBe(true);
    expect(storage.has(SCENARIO_DRAFT_KEY)).toBe(true);
    expect(loadScenarioDraft(storage)).toEqual(draft);
    clearScenarioDraft(storage);
    expect(storage.has(SCENARIO_DRAFT_KEY)).toBe(false);
    expect(loadScenarioDraft(storage)).toBeNull();
  });

  it('returns null when nothing is stored or the payload is malformed', () => {
    expect(loadScenarioDraft(memoryStorage())).toBeNull();
    expect(loadScenarioDraft(memoryStorage({ [SCENARIO_DRAFT_KEY]: '{bad json' }))).toBeNull();
  });

  it('rejects drafts that fail validation instead of recovering them', () => {
    const invalid = JSON.stringify({ changes: { pace: 'warp-speed' }, updatedAt: '2026-09-12T10:30:00.000Z', baseVersion: 'plan-9f2c1a00' });
    expect(loadScenarioDraft(memoryStorage({ [SCENARIO_DRAFT_KEY]: invalid }))).toBeNull();
  });
});
