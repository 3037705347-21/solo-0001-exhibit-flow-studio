import { describe, expect, it } from 'vitest';
import type { ExportRecord, WorkspaceState } from './models';
import { createSeedWorkspace } from '../state/seed';
import {
  applyZoneReorder,
  normalizeZoneOrder,
  previewZoneReorder,
  ZoneOrderConflictError,
  ZoneOrderValidationError,
  zoneOrderSignature,
} from './zoneReorder';

const SEED_ORDER = ['zone-arrival', 'zone-patterns', 'zone-common', 'zone-after'];
const SEED_SIGNATURE = SEED_ORDER.join('>');

function exportRecord(overrides: Partial<ExportRecord> & Pick<ExportRecord, 'id'>): ExportRecord {
  return {
    kind: 'snapshot',
    label: 'Readiness snapshot (JSON)',
    generatedAt: '2026-09-05T10:00:00.000Z',
    zoneOrderSignature: SEED_SIGNATURE,
    status: 'current',
    ...overrides,
  };
}

function stateWithExports(records: ExportRecord[]): WorkspaceState {
  return { ...createSeedWorkspace(), exports: records };
}

describe('normalizeZoneOrder', () => {
  it('keeps a deterministic effective order when sequences are duplicated', () => {
    const seed = createSeedWorkspace();
    const zones = seed.zones.map((zone, index) => ({ ...zone, sequence: index < 2 ? 0 : 1 }));
    // Duplicate sequences fall back to the stored relative order.
    expect(normalizeZoneOrder(zones).map((zone) => zone.id)).toEqual(SEED_ORDER);
    expect(zoneOrderSignature(zones)).toBe(SEED_SIGNATURE);
  });
});

describe('previewZoneReorder', () => {
  it('describes the timeline, materials, and readiness impact of a reorder', () => {
    const state = stateWithExports([
      exportRecord({ id: 'export-snapshot' }),
      exportRecord({ id: 'export-checklist', kind: 'zone-checklist', label: 'Arrival checklist', zoneId: 'zone-arrival' }),
      exportRecord({ id: 'export-already-stale', status: 'stale' }),
    ]);
    const ready: WorkspaceState = { ...state, project: { ...state.project, stage: 'ready' } };
    const target = ['zone-after', 'zone-arrival', 'zone-patterns', 'zone-common'];
    const result = previewZoneReorder(ready, target);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { preview } = result;
    expect(preview.isNoOp).toBe(false);
    expect(preview.baseSignature).toBe(SEED_SIGNATURE);
    expect(preview.targetSignature).toBe(target.join('>'));

    // Every zone moves in a full rotation; positions are reported 0-based.
    expect(preview.impact.changes).toHaveLength(4);
    expect(preview.impact.changes.find((change) => change.zoneId === 'zone-after')).toMatchObject({ fromIndex: 3, toIndex: 0 });

    // The visit timeline follows the staged order.
    expect(preview.impact.timelineBefore.nodes.map((node) => node.zoneId)).toEqual(SEED_ORDER);
    expect(preview.impact.timelineAfter.nodes.map((node) => node.zoneId)).toEqual(target);
    expect(preview.impact.newHandoffs).toContain('Afterlives → Arrival');
    expect(preview.impact.removedHandoffs).toContain('Common Thread → Afterlives');

    // Only current exports generated against the old order will be invalidated.
    expect(preview.impact.staleExports.map((record) => record.id)).toEqual(['export-snapshot', 'export-checklist']);

    // The resolved finding linked to the moved Common Thread zone is flagged.
    expect(preview.impact.reReviewIssues.map((issue) => issue.id)).toEqual(['issue-quilt-light']);
    expect(preview.impact.readinessRegresses).toBe(true);
  });

  it('does not flag findings for zones that keep their position', () => {
    const state = createSeedWorkspace();
    // Swap the first two zones only; zone-common (home of the resolved finding) stays put.
    const result = previewZoneReorder(state, ['zone-patterns', 'zone-arrival', 'zone-common', 'zone-after']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.impact.reReviewIssues).toEqual([]);
    expect(result.preview.impact.readinessRegresses).toBe(false);
  });

  it('marks an unchanged order as a no-op', () => {
    const result = previewZoneReorder(createSeedWorkspace(), SEED_ORDER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.isNoOp).toBe(true);
    expect(result.preview.impact.changes).toEqual([]);
  });

  it('rejects staged orders that are not a permutation of the zones', () => {
    const state = createSeedWorkspace();
    expect(previewZoneReorder(state, SEED_ORDER.slice(1)).ok).toBe(false);
    expect(previewZoneReorder(state, [...SEED_ORDER, 'zone-ghost']).ok).toBe(false);
    expect(previewZoneReorder(state, ['zone-arrival', 'zone-arrival', 'zone-common', 'zone-after']).ok).toBe(false);
  });

  it('never mutates the workspace while staging', () => {
    const state = stateWithExports([exportRecord({ id: 'export-snapshot' })]);
    const snapshot = JSON.parse(JSON.stringify(state)) as WorkspaceState;
    previewZoneReorder(state, ['zone-after', 'zone-arrival', 'zone-patterns', 'zone-common']);
    expect(state).toEqual(snapshot);
  });
});

describe('applyZoneReorder', () => {
  it('commits the reorder and invalidates every dependent output by rule', () => {
    const at = new Date('2026-09-12T09:00:00.000Z');
    const seed = createSeedWorkspace();
    const state: WorkspaceState = {
      ...seed,
      project: { ...seed.project, stage: 'ready' },
      exports: [exportRecord({ id: 'export-snapshot' })],
    };
    const target = ['zone-after', 'zone-arrival', 'zone-patterns', 'zone-common'];
    const next = applyZoneReorder(state, target, SEED_SIGNATURE, at);

    // All sequences are rewritten to a clean 0..n-1 range in the new order.
    expect(next.zones.find((zone) => zone.id === 'zone-after')?.sequence).toBe(0);
    expect(next.zones.find((zone) => zone.id === 'zone-arrival')?.sequence).toBe(1);
    expect(next.zones.find((zone) => zone.id === 'zone-patterns')?.sequence).toBe(2);
    expect(next.zones.find((zone) => zone.id === 'zone-common')?.sequence).toBe(3);
    expect(zoneOrderSignature(next.zones)).toBe(target.join('>'));

    // The export made against the old order is invalidated.
    expect(next.exports[0]).toMatchObject({ id: 'export-snapshot', status: 'stale' });

    // The resolved finding on a moved zone is flagged for re-review.
    const quilt = next.issues.find((issue) => issue.id === 'issue-quilt-light');
    expect(quilt).toMatchObject({ status: 'in-progress', resolvedAt: undefined, updatedAt: at.toISOString() });
    // Findings that were not resolved stay on their own track.
    expect(next.issues.find((issue) => issue.id === 'issue-entry-copy')?.status).toBe('open');
    expect(next.issues.find((issue) => issue.id === 'issue-audio-transcript')?.status).toBe('in-progress');

    // A ready plan regresses to review.
    expect(next.project.stage).toBe('review');

    // The committed state is new; the old order and outputs are untouched.
    expect(zoneOrderSignature(state.zones)).toBe(SEED_SIGNATURE);
    expect(state.exports[0].status).toBe('current');
    expect(state.issues.find((issue) => issue.id === 'issue-quilt-light')?.status).toBe('resolved');
    expect(state.project.stage).toBe('ready');
  });

  it('normalizes duplicate sequences when the reorder commits', () => {
    const seed = createSeedWorkspace();
    const state: WorkspaceState = {
      ...seed,
      zones: seed.zones.map((zone, index) => ({ ...zone, sequence: index < 2 ? 0 : 1 })),
    };
    const target = ['zone-after', 'zone-common', 'zone-patterns', 'zone-arrival'];
    const next = applyZoneReorder(state, target, zoneOrderSignature(state.zones));
    expect(next.zones.map((zone) => zone.sequence).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(normalizeZoneOrder(next.zones).map((zone) => zone.id)).toEqual(target);
  });

  it('refuses to overwrite an order that changed since the preview was prepared', () => {
    const state = createSeedWorkspace();
    const concurrentOrder = ['zone-patterns', 'zone-arrival', 'zone-common', 'zone-after'];
    // A concurrent change commits first, moving the stored order on.
    const moved = applyZoneReorder(state, concurrentOrder, SEED_SIGNATURE);
    // The stale preview must not push the old order back over the newer one.
    expect(() => applyZoneReorder(moved, ['zone-after', 'zone-arrival', 'zone-patterns', 'zone-common'], SEED_SIGNATURE))
      .toThrow(ZoneOrderConflictError);
    expect(zoneOrderSignature(moved.zones)).toBe(concurrentOrder.join('>'));
  });

  it('rejects no-op and incomplete commits', () => {
    const state = createSeedWorkspace();
    expect(() => applyZoneReorder(state, SEED_ORDER, SEED_SIGNATURE)).toThrow(ZoneOrderValidationError);
    expect(() => applyZoneReorder(state, SEED_ORDER.slice(1), SEED_SIGNATURE)).toThrow(ZoneOrderValidationError);
  });

  it('restores the full old order and outputs when the commit fails', () => {
    const state = stateWithExports([exportRecord({ id: 'export-snapshot' })]);
    expect(() => applyZoneReorder(state, ['zone-after', 'zone-arrival', 'zone-patterns', 'zone-common'], 'stale-signature'))
      .toThrow(ZoneOrderConflictError);
    expect(zoneOrderSignature(state.zones)).toBe(SEED_SIGNATURE);
    expect(state.exports[0].status).toBe('current');
    expect(state.issues.find((issue) => issue.id === 'issue-quilt-light')?.status).toBe('resolved');
  });

  it('applies the same rules to the sample plan zones', () => {
    const state = createSeedWorkspace();
    const reversed = [...SEED_ORDER].reverse();
    const next = applyZoneReorder(state, reversed, zoneOrderSignature(state.zones));
    expect(normalizeZoneOrder(next.zones).map((zone) => zone.id)).toEqual(reversed);
    expect(next.zones.map((zone) => zone.sequence).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });
});
