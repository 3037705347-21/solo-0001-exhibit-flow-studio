import { describe, expect, it } from 'vitest';
import {
  backupFileName,
  clearWorkspace,
  loadWorkspace,
  parseBackup,
  saveWorkspace,
  serializeBackup,
  STORAGE_KEY,
} from './persistence';
import { migrateWorkspace } from './migrations';
import { createSeedWorkspace } from './seed';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    length: values.size,
  } as unknown as Storage;
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
    expect(loadWorkspace(storage).project.title).toBe(state.project.title);
    clearWorkspace(storage);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });
  it('persists lineage and reloads the exact provenance graph', () => {
    const storage = memoryStorage();
    const state = createSeedWorkspace();
    saveWorkspace(state, storage);
    const reloaded = loadWorkspace(storage);
    expect(reloaded.lineage.nodes.length).toBe(state.lineage.nodes.length);
    expect(reloaded.lineage.edges.length).toBe(state.lineage.edges.length);
    expect(reloaded.lineage.batches).toEqual([]);
  });
  it('backfills lineage for a legacy workspace without duplicating on the second load', () => {
    const legacyRaw = JSON.stringify((() => {
      const seed = createSeedWorkspace();
      const { lineage: _lineage, ...legacy } = seed;
      void _lineage;
      return legacy;
    })());
    const storage: Storage = {
      ...memoryStorage(),
      getItem: () => legacyRaw,
    } as unknown as Storage;
    const first = loadWorkspace(storage);
    expect(first.lineage.nodes.length).toBeGreaterThan(0);
    const second = loadWorkspace(storage);
    expect(second.lineage.nodes.length).toBe(first.lineage.nodes.length);
    expect(second.lineage.edges.length).toBe(first.lineage.edges.length);
  });
  it('migrates a pre-lineage workspace shape', () => {
    const seed = createSeedWorkspace();
    const { lineage: _lineage, ...legacy } = seed;
    void _lineage;
    const migrated = migrateWorkspace(legacy);
    expect(migrated?.lineage).toEqual({ nodes: [], edges: [], batches: [] });
  });
});

describe('backup round trip', () => {
  it('serializes and parses a backup including the lineage graph', () => {
    const state = createSeedWorkspace();
    const raw = serializeBackup(state);
    const restored = parseBackup(raw);
    expect(restored).not.toBeNull();
    expect(restored?.lineage.nodes.length).toBe(state.lineage.nodes.length);
    expect(restored?.lineage.edges.length).toBe(state.lineage.edges.length);
  });
  it('rejects a non-backup file', () => {
    expect(parseBackup('{"kind":"something-else","workspace":{}}')).toBeNull();
    expect(parseBackup('not json')).toBeNull();
  });
  it('uses a dated backup file name', () => {
    expect(backupFileName(new Date('2027-01-02T00:00:00Z'))).toBe('exhibit-flow-backup-2027-01-02.json');
  });
});
