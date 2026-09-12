import { describe, expect, it } from 'vitest';
import {
  clearWorkspace,
  COLLECTION_UI_KEY,
  loadCollectionUi,
  loadWorkspace,
  saveCollectionUi,
  saveWorkspace,
  STORAGE_KEY,
} from './persistence';
import { createSeedWorkspace } from './seed';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(initial));
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } as unknown as Storage;
  return { storage, values };
}

describe('workspace persistence', () => {
  it('falls back to seed state for malformed storage', () => {
    const storage = { getItem: () => '{bad json' } as unknown as Storage;
    expect(loadWorkspace(storage).version).toBe(1);
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
});

describe('collection ui persistence', () => {
  it('restores the saved sort after a reload', () => {
    const { storage } = memoryStorage();
    saveCollectionUi({ key: 'title', direction: 'desc' }, storage);
    expect(loadCollectionUi(storage)).toEqual({ key: 'title', direction: 'desc' });
  });

  it('falls back to the default sort for missing or corrupted storage', () => {
    expect(loadCollectionUi(memoryStorage().storage)).toEqual({ key: 'added', direction: 'asc' });
    expect(loadCollectionUi(memoryStorage({ [COLLECTION_UI_KEY]: '{bad json' }).storage)).toEqual({ key: 'added', direction: 'asc' });
    expect(loadCollectionUi(memoryStorage({ [COLLECTION_UI_KEY]: '{"key":"unknown","direction":"desc"}' }).storage)).toEqual({ key: 'added', direction: 'desc' });
  });

  it('keeps the sort preference out of the workspace document', () => {
    const { storage, values } = memoryStorage();
    saveCollectionUi({ key: 'dwellMinutes', direction: 'desc' }, storage);
    expect(values.has(COLLECTION_UI_KEY)).toBe(true);
    expect(values.has(STORAGE_KEY)).toBe(false);
  });
});
