import { describe, expect, it } from 'vitest';
import { isPermutationOf } from '../domain/reorder';
import type { WorkspaceState } from '../domain/models';
import { workspaceReducer } from './reducer';
import { createSeedWorkspace } from './seed';
import { canRedo, canUndo, createHistory, pushHistory, redoHistory, undoHistory, type WorkspaceHistory } from './undoStack';

const ZONE = 'zone-common';
const SEED_ORDER = ['artifact-press', 'artifact-quilt'];

function reorder(state: WorkspaceState, artifactId: string, nextOrder: string[]): WorkspaceState {
  const zone = state.zones.find((candidate) => candidate.id === ZONE);
  if (!zone) throw new Error('zone missing');
  return workspaceReducer(state, {
    type: 'placement/reorder',
    zoneId: ZONE,
    artifactId,
    expectedVersion: zone.version,
    nextOrder,
  });
}

function orderOf(state: WorkspaceState): string[] {
  const zone = state.zones.find((candidate) => candidate.id === ZONE);
  if (!zone) throw new Error('zone missing');
  return zone.artifactIds;
}

function expectInvariant(state: WorkspaceState) {
  for (const zone of state.zones) {
    expect(new Set(zone.artifactIds).size, `duplicate ids in ${zone.id}`).toBe(zone.artifactIds.length);
  }
  expect(isPermutationOf(orderOf(state), SEED_ORDER)).toBe(true);
}

/** Mirror of the provider: record every committed state that is not an undo/redo restore. */
function commit(history: WorkspaceHistory, next: WorkspaceState): WorkspaceHistory {
  return next === history.present ? history : pushHistory(history, next);
}

describe('reorder undo/redo history', () => {
  it('undoes and redoes consecutive reorders without losing or duplicating objects', () => {
    const seed = createSeedWorkspace();
    let history = createHistory(seed);

    const afterFirst = reorder(seed, 'artifact-quilt', ['artifact-quilt', 'artifact-press']);
    history = commit(history, afterFirst);
    const afterSecond = reorder(afterFirst, 'artifact-quilt', ['artifact-press', 'artifact-quilt']);
    history = commit(history, afterSecond);

    expect(orderOf(history.present)).toEqual(SEED_ORDER); // quilt moved up then back down
    expect(canUndo(history)).toBe(true);

    history = undoHistory(history);
    expect(orderOf(history.present)).toEqual(['artifact-quilt', 'artifact-press']);
    expectInvariant(history.present);

    history = undoHistory(history);
    expect(orderOf(history.present)).toEqual(SEED_ORDER);
    expectInvariant(history.present);
    expect(canUndo(history)).toBe(false);

    history = redoHistory(history);
    expect(orderOf(history.present)).toEqual(['artifact-quilt', 'artifact-press']);
    history = redoHistory(history);
    expect(orderOf(history.present)).toEqual(SEED_ORDER);
    expectInvariant(history.present);
    expect(canRedo(history)).toBe(false);
  });

  it('clears the redo stack when a new reorder lands after an undo', () => {
    const seed = createSeedWorkspace();
    let history = createHistory(seed);
    const up = reorder(seed, 'artifact-quilt', ['artifact-quilt', 'artifact-press']);
    history = commit(history, up);
    const downAgain = reorder(up, 'artifact-quilt', SEED_ORDER);
    history = commit(history, downAgain);

    history = undoHistory(history); // back to "quilt first"
    expect(canRedo(history)).toBe(true);

    // A new operation after the undo must invalidate the redo future.
    const otherZone = workspaceReducer(history.present, {
      type: 'placement/reorder',
      zoneId: 'zone-after',
      artifactId: 'artifact-tape',
      expectedVersion: history.present.zones.find((zone) => zone.id === 'zone-after')?.version ?? 0,
      nextOrder: ['artifact-tape', 'artifact-bowl'],
    });
    history = commit(history, otherZone);
    expect(canRedo(history)).toBe(false);
    expectInvariant(history.present);

    // Undo walks back through both operations; every visited state is intact.
    history = undoHistory(history);
    expect(orderOf(history.present)).toEqual(['artifact-quilt', 'artifact-press']);
    expectInvariant(history.present);
    history = undoHistory(history);
    expect(orderOf(history.present)).toEqual(SEED_ORDER);
    expectInvariant(history.present);
  });

  it('does not record no-op reorders (boundary drags) as history entries', () => {
    const seed = createSeedWorkspace();
    let history = createHistory(seed);
    // Boundary: press is already first — the reducer returns the same state.
    const boundary = reorder(seed, 'artifact-press', SEED_ORDER);
    expect(boundary).toBe(seed);
    history = commit(history, boundary);
    expect(canUndo(history)).toBe(false);
  });

  it('chains rapid repeated drags, each based on the version produced by the previous one', () => {
    const seed = createSeedWorkspace();
    let history = createHistory(seed);
    let state = seed;
    // Quilt alternates down/up ten times; versions chain 1 → 2 → 3 …
    for (let step = 0; step < 10; step += 1) {
      const target = step % 2 === 0 ? ['artifact-quilt', 'artifact-press'] : SEED_ORDER;
      state = reorder(state, 'artifact-quilt', target);
      history = commit(history, state);
    }
    expect(orderOf(state)).toEqual(SEED_ORDER);
    expectInvariant(state);
    // Every step is individually undoable and each visited state stays valid.
    for (let step = 0; step < 10; step += 1) {
      history = undoHistory(history);
      expectInvariant(history.present);
    }
    expect(orderOf(history.present)).toEqual(SEED_ORDER);
    expect(canUndo(history)).toBe(false);
  });
});
