import { describe, expect, it } from 'vitest';
import {
  clearWorkspace,
  commitInitialMigration,
  commitWorkspace,
  loadWorkspace,
  RECOVERY_KEY,
  STORAGE_KEY,
} from './persistence';
import { createSeedWorkspace } from './seed';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage = {
    getItem: (key: string) => (values.has(key) ? values.get(key)! : null),
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  return { storage: storage as unknown as Storage, values };
}

describe('workspace persistence', () => {
  it('falls back to seed state for malformed storage and preserves the bad copy', () => {
    const { storage } = memoryStorage({ [STORAGE_KEY]: '{bad json' });
    const loaded = loadWorkspace(storage);
    expect(loaded.workspace.version).toBe(1);
    expect(loaded.recovered).toBe(true);
    const recovered = JSON.parse(storage.getItem(RECOVERY_KEY) as string);
    expect(recovered.raw).toBe('{bad json');
  });

  it('round trips a workspace through storage with monotonically increasing revisions', () => {
    const { storage } = memoryStorage();
    const state = createSeedWorkspace();
    const first = commitWorkspace(state, 1, storage);
    expect(first.kind).toBe('committed');
    if (first.kind !== 'committed') return;
    expect(first.revision).toBe(2);
    const loaded = loadWorkspace(storage);
    expect(loaded.workspace.project.title).toBe(state.project.title);
    expect(loaded.revision).toBe(2);

    const second = commitWorkspace(state, 2, storage);
    expect(second.kind).toBe('committed');
    if (second.kind === 'committed') expect(second.revision).toBe(3);
    clearWorkspace(storage);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('rejects a commit based on a stale revision without overwriting', () => {
    const { storage } = memoryStorage();
    const seed = createSeedWorkspace();
    const first = commitWorkspace(seed, 1, storage);
    expect(first.kind).toBe('committed');
    if (first.kind !== 'committed') return;
    const second = commitWorkspace(seed, 2, storage); // advances storage to revision 3
    expect(second.kind).toBe('committed');

    const stale = commitWorkspace(seed, 1, storage);
    expect(stale.kind).toBe('conflict');
    if (stale.kind === 'conflict') expect(stale.currentRevision).toBe(3);
    const raw = JSON.parse(storage.getItem(STORAGE_KEY) as string);
    expect(raw.revision).toBe(3);
  });

  it('rolls back when the written document cannot be verified', () => {
    const { storage, values } = memoryStorage();
    const seed = createSeedWorkspace();
    const first = commitWorkspace(seed, 1, storage);
    expect(first.kind).toBe('committed');
    const before = storage.getItem(STORAGE_KEY) as string;

    // The pre-write read sees revision 2 normally; only the verification read-back is interrupted.
    let writes = 0;
    const flaky = {
      getItem: (key: string) => {
        const current = values.get(key) ?? null;
        if (key === STORAGE_KEY && writes > 0 && current !== null && JSON.parse(current).revision === 3) return '';
        return current;
      },
      setItem: (key: string, value: string) => { writes += 1; values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } as unknown as Storage;
    const result = commitWorkspace(seed, 2, flaky);
    expect(result.kind).toBe('unavailable');
    expect(storage.getItem(STORAGE_KEY)).toBe(before);
  });

  it('migrates a legacy bare workspace transparently and idempotently', () => {
    const { storage } = memoryStorage();
    const seed = createSeedWorkspace();
    storage.setItem(STORAGE_KEY, JSON.stringify(seed));
    const loaded = loadWorkspace(storage);
    expect(loaded.legacy).toBe(true);
    expect(loaded.revision).toBe(1);

    const migration = commitInitialMigration(seed, storage);
    expect(migration.kind).toBe('migrated');
    const wrapped = loadWorkspace(storage);
    expect(wrapped.legacy).toBe(false);
    expect(wrapped.revision).toBe(1);
    expect(wrapped.workspace.project.title).toBe(seed.project.title);

    // Another tab attempting the migration after the same content was wrapped sees it as done.
    const again = commitInitialMigration(seed, storage);
    expect(again.kind).toBe('advanced');
  });

  it('reports a write failure rather than throwing when storage throws', () => {
    const broken = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    } as unknown as Storage;
    const outcome = commitWorkspace(createSeedWorkspace(), 1, broken);
    expect(outcome.kind).toBe('unavailable');
    expect(loadWorkspace(broken).workspace.version).toBe(1);
  });

  it('never auto-commits over an unreadable document and keeps the recovery copy', () => {
    const { storage } = memoryStorage({ [STORAGE_KEY]: '{not json' });
    const seed = createSeedWorkspace();
    const outcome = commitWorkspace(seed, 1, storage);
    expect(outcome.kind).toBe('unavailable');
    expect(storage.getItem(STORAGE_KEY)).toBe('{not json');
    expect(storage.getItem(RECOVERY_KEY)).not.toBeNull();
  });
});
