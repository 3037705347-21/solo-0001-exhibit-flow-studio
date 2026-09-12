import { describe, expect, it } from 'vitest';
import { ZoneOrderConflictError, zoneOrderSignature } from '../domain/zoneReorder';
import type { ExportRecord } from '../domain/models';
import { workspaceReducer } from './reducer';
import { createSeedWorkspace } from './seed';

const SEED_ORDER = ['zone-arrival', 'zone-patterns', 'zone-common', 'zone-after'];

function checklistRecord(state = createSeedWorkspace()): ExportRecord {
  return {
    id: 'export-checklist-1',
    kind: 'zone-checklist',
    label: 'Arrival / A Light Carried checklist',
    zoneId: 'zone-arrival',
    generatedAt: '2026-09-12T09:00:00.000Z',
    zoneOrderSignature: zoneOrderSignature(state.zones),
    status: 'current',
  };
}

describe('zone/reorder command', () => {
  it('applies a confirmed reorder and stamps the save time', () => {
    const state = createSeedWorkspace();
    const target = ['zone-after', 'zone-arrival', 'zone-patterns', 'zone-common'];
    const next = workspaceReducer(state, {
      type: 'zone/reorder',
      order: target,
      baseSignature: zoneOrderSignature(state.zones),
      at: '2026-09-12T09:00:00.000Z',
    });
    expect(zoneOrderSignature(next.zones)).toBe(target.join('>'));
    expect(next.lastSavedAt).not.toBe(state.lastSavedAt);
  });

  it('regresses a ready project when the visit order changes', () => {
    const seed = createSeedWorkspace();
    const ready = { ...seed, project: { ...seed.project, stage: 'ready' as const } };
    const next = workspaceReducer(ready, {
      type: 'zone/reorder',
      order: [...SEED_ORDER].reverse(),
      baseSignature: zoneOrderSignature(ready.zones),
    });
    expect(next.project.stage).toBe('review');
  });

  it('marks recorded exports stale once the reorder commits', () => {
    const state = createSeedWorkspace();
    const recorded = workspaceReducer(state, { type: 'export/record', record: checklistRecord(state) });
    const reordered = workspaceReducer(recorded, {
      type: 'zone/reorder',
      order: [...SEED_ORDER].reverse(),
      baseSignature: zoneOrderSignature(recorded.zones),
    });
    expect(reordered.exports[0].status).toBe('stale');
  });

  it('throws instead of overwriting when the stored order moved on', () => {
    const state = createSeedWorkspace();
    const concurrentOrder = ['zone-patterns', 'zone-arrival', 'zone-common', 'zone-after'];
    const moved = workspaceReducer(state, {
      type: 'zone/reorder',
      order: concurrentOrder,
      baseSignature: zoneOrderSignature(state.zones),
    });
    expect(() => workspaceReducer(moved, {
      type: 'zone/reorder',
      order: [...SEED_ORDER].reverse(),
      baseSignature: zoneOrderSignature(state.zones),
    })).toThrow(ZoneOrderConflictError);
    // The newer order survives the rejected commit.
    expect(zoneOrderSignature(moved.zones)).toBe(concurrentOrder.join('>'));
  });

  it('rejects a no-op reorder and leaves state intact', () => {
    const state = createSeedWorkspace();
    expect(() => workspaceReducer(state, {
      type: 'zone/reorder',
      order: SEED_ORDER,
      baseSignature: zoneOrderSignature(state.zones),
    })).toThrow();
    expect(zoneOrderSignature(state.zones)).toBe(SEED_ORDER.join('>'));
  });
});

describe('export/record command', () => {
  it('prepends exported materials to the ledger', () => {
    const state = createSeedWorkspace();
    const record = checklistRecord(state);
    const next = workspaceReducer(state, { type: 'export/record', record });
    expect(next.exports).toHaveLength(1);
    expect(next.exports[0]).toEqual(record);
  });
});
