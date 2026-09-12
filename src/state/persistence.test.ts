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

describe('workspace persistence', () => {
  it('falls back to seed state for malformed storage', () => {
    const storage = { getItem: () => '{bad json' } as unknown as Storage;
    expect(loadWorkspace(storage).version).toBe(1);
  });
  it('round trips a workspace through storage', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } } as unknown as Storage;
    const state = createSeedWorkspace();
    expect(saveWorkspace(state, storage)).toBe(true);
    expect(values.has(STORAGE_KEY)).toBe(true);
    expect(loadWorkspace(storage).project.title).toBe(state.project.title);
    clearWorkspace(storage);
    expect(values.has(STORAGE_KEY)).toBe(false);
  });
});

describe('collection UI persistence', () => {
  function storageWith(values: Record<string, string>) {
    return {
      getItem: (key: string) => values[key] ?? null,
      setItem: (key: string, value: string) => { values[key] = value; },
      removeItem: (key: string) => { delete values[key]; },
    } as unknown as Storage;
  }

  it('round trips the draft and selected view id', () => {
    const values: Record<string, string> = {};
    const storage = storageWith(values);
    saveCollectionUi({ draft: { query: 'lantern', roles: ['threshold'], sensitivities: [], keyOnly: true }, selectedViewId: 'view-1' }, storage);
    const restored = loadCollectionUi(storage, new Set(['view-1']));
    expect(restored.selectedViewId).toBe('view-1');
    expect(restored.draft.query).toBe('lantern');
    expect(restored.draft.keyOnly).toBe(true);
    expect(values[COLLECTION_UI_KEY]).toContain('view-1');
  });

  it('drops a selected view id when the view no longer exists so selection cannot outlive the view', () => {
    const storage = storageWith({
      [COLLECTION_UI_KEY]: JSON.stringify({ draft: { query: '', roles: [], sensitivities: [], keyOnly: false }, selectedViewId: 'deleted-view' }),
    });
    expect(loadCollectionUi(storage, new Set(['view-1'])).selectedViewId).toBeNull();
  });

  it('never stores or infers a kind from UI state: malformed drafts reset to defaults', () => {
    const storage = storageWith({
      [COLLECTION_UI_KEY]: JSON.stringify({ draft: { query: 9, roles: [], sensitivities: [], keyOnly: false }, selectedViewId: 'view-1' }),
    });
    const restored = loadCollectionUi(storage, new Set(['view-1']));
    expect(restored.selectedViewId).toBeNull();
    expect(restored.draft).toEqual({ query: '', roles: [], sensitivities: [], keyOnly: false });
  });
});
