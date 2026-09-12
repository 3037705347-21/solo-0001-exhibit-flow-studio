import { describe, expect, it } from 'vitest';
import {
  dedupeOrder,
  diffZoneOrders,
  isPermutationOf,
  moveInOrder,
  resolveZoneReorder,
  type ReorderResolution,
} from './reorder';

const ABC = ['a', 'b', 'c', 'd'];

describe('moveInOrder', () => {
  it('moves an object to an exact index', () => {
    expect(moveInOrder(ABC, 'a', 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveInOrder(ABC, 'd', 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveInOrder(ABC, 'b', 3)).toEqual(['a', 'c', 'd', 'b']);
    expect(moveInOrder(ABC, 'c', 1)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('clamps targets beyond the boundaries instead of dropping the object', () => {
    expect(moveInOrder(ABC, 'a', -5)).toBe(ABC); // already first: no-op
    expect(moveInOrder(ABC, 'b', -5)).toEqual(['b', 'a', 'c', 'd']);
    expect(moveInOrder(ABC, 'd', 99)).toBe(ABC); // already last: no-op
    expect(moveInOrder(ABC, 'c', 99)).toEqual(['a', 'b', 'd', 'c']);
  });

  it('returns the same array when the move lands on the original position', () => {
    expect(moveInOrder(ABC, 'b', 1)).toBe(ABC);
  });

  it('ignores unknown objects without changing the order', () => {
    expect(moveInOrder(ABC, 'zzz', 1)).toBe(ABC);
  });
});

describe('dedupeOrder', () => {
  it('keeps the first occurrence of each id', () => {
    expect(dedupeOrder(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
  });
});

describe('isPermutationOf', () => {
  it('accepts exact permutations and rejects loss, duplication, and foreign ids', () => {
    expect(isPermutationOf(['b', 'a'], ['a', 'b'])).toBe(true);
    expect(isPermutationOf(['a'], ['a', 'b'])).toBe(false);
    expect(isPermutationOf(['a', 'a'], ['a', 'b'])).toBe(false);
    expect(isPermutationOf(['a', 'x'], ['a', 'b'])).toBe(false);
  });
});

describe('diffZoneOrders', () => {
  it('describes removals, additions, and moves deterministically', () => {
    const lines = diffZoneOrders(['a', 'b', 'c'], ['c', 'x', 'a']);
    expect(lines).toEqual([
      '“b” was removed from the zone',
      '“c” moved from position 3 to 1',
      '“x” was added at position 2',
      '“a” moved from position 1 to 3',
    ]);
  });

  it('uses display titles when provided', () => {
    const lines = diffZoneOrders(['a'], ['b'], (id) => (id === 'a' ? 'Lantern' : 'Radio'));
    expect(lines).toEqual(['“Lantern” was removed from the zone', '“Radio” was added at position 1']);
  });

  it('is empty for identical orders', () => {
    expect(diffZoneOrders(['a', 'b'], ['a', 'b'])).toEqual([]);
  });
});

describe('resolveZoneReorder', () => {
  it('applies the requested move when the version matches', () => {
    const resolution = resolveZoneReorder({
      baseOrder: ['a', 'b', 'c'],
      currentOrder: ['a', 'b', 'c'],
      artifactId: 'c',
      targetIndex: 0,
      versionMismatch: false,
    });
    expect(resolution).toEqual({ kind: 'apply', nextOrder: ['c', 'a', 'b'] });
  });

  it('treats boundary moves and drags back to the original position as no-ops', () => {
    const base = { baseOrder: ['a', 'b'], currentOrder: ['a', 'b'], versionMismatch: false };
    expect(resolveZoneReorder({ ...base, artifactId: 'a', targetIndex: -1 }).kind).toBe('noop');
    expect(resolveZoneReorder({ ...base, artifactId: 'b', targetIndex: 5 }).kind).toBe('noop');
    expect(resolveZoneReorder({ ...base, artifactId: 'a', targetIndex: 0 }).kind).toBe('noop');
  });

  it('rebases onto external edits without losing or duplicating objects', () => {
    // Client saw [press, quilt, bowl] and dragged bowl above press; meanwhile
    // another tab swapped press and quilt and added gloves at the end.
    const resolution = resolveZoneReorder({
      baseOrder: ['press', 'quilt', 'bowl'],
      currentOrder: ['quilt', 'press', 'bowl', 'gloves'],
      artifactId: 'bowl',
      targetIndex: 0,
      versionMismatch: true,
    });
    expect(resolution.kind).toBe('rebase');
    if (resolution.kind !== 'rebase') return;
    // Bowl lands before press (its successor anchor); gloves stay put.
    expect(resolution.nextOrder).toEqual(['quilt', 'bowl', 'press', 'gloves']);
    expect(isPermutationOf(resolution.nextOrder, ['quilt', 'press', 'bowl', 'gloves'])).toBe(true);
    expect(resolution.changes.length).toBeGreaterThan(0);
  });

  it('moves to the end when the base move targeted the last position', () => {
    const resolution = resolveZoneReorder({
      baseOrder: ['press', 'quilt', 'bowl'],
      currentOrder: ['quilt', 'press', 'bowl'],
      artifactId: 'quilt',
      targetIndex: 2,
      versionMismatch: true,
    });
    expect(resolution).toMatchObject({ kind: 'rebase', nextOrder: ['press', 'bowl', 'quilt'] });
  });

  it('falls back to a clamped position when the successor anchor was removed', () => {
    // Client moved "a" ahead of "d", but another tab removed "d" entirely.
    const resolution = resolveZoneReorder({
      baseOrder: ['a', 'b', 'c', 'd'],
      currentOrder: ['a', 'b', 'c'],
      artifactId: 'a',
      targetIndex: 2,
      versionMismatch: true,
    });
    expect(resolution.kind).toBe('rebase');
    if (resolution.kind !== 'rebase') return;
    expect(resolution.nextOrder).toEqual(['b', 'c', 'a']);
    expect(resolution.changes).toEqual(['“d” was removed from the zone']);
  });

  it('inserts before the surviving successor anchor', () => {
    // Client moved "a" below "c" (successor "d"); "d" survives externally.
    const resolution = resolveZoneReorder({
      baseOrder: ['a', 'b', 'c', 'd'],
      currentOrder: ['a', 'b', 'd'],
      artifactId: 'a',
      targetIndex: 2,
      versionMismatch: true,
    });
    expect(resolution.kind).toBe('rebase');
    if (resolution.kind !== 'rebase') return;
    expect(resolution.nextOrder).toEqual(['b', 'a', 'd']);
  });

  it('conflicts when the dragged object is no longer in the zone', () => {
    const resolution = resolveZoneReorder({
      baseOrder: ['a', 'b', 'c'],
      currentOrder: ['a', 'c'],
      artifactId: 'b',
      targetIndex: 0,
      versionMismatch: true,
    });
    expect(resolution.kind).toBe('conflict');
    if (resolution.kind !== 'conflict') return;
    expect(resolution.reason).toBeTruthy();
    expect(resolution.changes).toEqual(['“b” was removed from the zone', '“c” moved from position 3 to 2']);
  });

  it('is a no-op when the external change already satisfies the intent', () => {
    // Client wanted "b" first; another tab already moved it there.
    const resolution = resolveZoneReorder({
      baseOrder: ['a', 'b'],
      currentOrder: ['b', 'a'],
      artifactId: 'b',
      targetIndex: 0,
      versionMismatch: true,
    });
    expect(resolution.kind).toBe('noop');
  });

  it('normalizes duplicated input instead of propagating corruption', () => {
    const resolution = resolveZoneReorder({
      baseOrder: ['a', 'b', 'b'],
      currentOrder: ['a', 'b', 'b'],
      artifactId: 'b',
      targetIndex: 0,
      versionMismatch: false,
    });
    expect(resolution).toEqual({ kind: 'apply', nextOrder: ['b', 'a'] });
  });

  it('is deterministic: identical intents always resolve identically', () => {
    const intent = {
      baseOrder: ['x', 'y', 'z', 'w'],
      currentOrder: ['y', 'x', 'q', 'w'],
      artifactId: 'w',
      targetIndex: 1,
      versionMismatch: true,
    };
    const first = resolveZoneReorder(intent);
    const second = resolveZoneReorder(intent);
    expect(first).toEqual(second);
    expect(first.kind).toBe('rebase');
  });

  it('never loses or duplicates objects across a grid of scenarios', () => {
    const currents = [
      ['a', 'b', 'c'],
      ['b', 'a', 'c'],
      ['a', 'c'],
      ['a', 'b', 'c', 'e'],
      ['c', 'b', 'a'],
    ];
    for (const currentOrder of currents) {
      for (const artifactId of ['a', 'b', 'c', 'missing']) {
        for (let targetIndex = -1; targetIndex <= 4; targetIndex += 1) {
          const resolution: ReorderResolution = resolveZoneReorder({
            baseOrder: ['a', 'b', 'c'],
            currentOrder,
            artifactId,
            targetIndex,
            versionMismatch: true,
          });
          if (resolution.kind === 'rebase') {
            const dedupedCurrent = dedupeOrder(currentOrder);
            expect(isPermutationOf(resolution.nextOrder, dedupedCurrent)).toBe(true);
            expect(new Set(resolution.nextOrder).size).toBe(resolution.nextOrder.length);
          }
        }
      }
    }
  });
});
