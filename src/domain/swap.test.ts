import { describe, expect, it } from 'vitest';
import { analyzeJourney, getUnplacedArtifacts } from './journeyAnalysis';
import { buildSnapshot, evaluateReadiness } from './reviewRules';
import { applyArtifactSwap, planArtifactSwap, swapRequestFromPreview } from './swap';
import { loadWorkspace, saveWorkspace, STORAGE_KEY } from '../state/persistence';
import { workspaceReducer } from '../state/reducer';
import { createSeedWorkspace } from '../state/seed';
import type { WorkspaceState } from './models';

function placedIds(state: WorkspaceState, zoneId: string): string[] {
  return state.zones.find((zone) => zone.id === zoneId)?.artifactIds ?? [];
}

function swapPair(state: WorkspaceState, firstId: string, secondId: string) {
  const preview = planArtifactSwap(state, firstId, secondId);
  if (!preview) throw new Error('Expected a swap preview for the seed plan.');
  return { preview, request: swapRequestFromPreview(preview) };
}

describe('swap planning', () => {
  it('previews positions and capacity changes for a valid swap', () => {
    const state = createSeedWorkspace();
    const { preview } = swapPair(state, 'artifact-lantern', 'artifact-radio');
    expect(preview.canSwap).toBe(true);
    expect(preview.errors).toHaveLength(0);
    expect(preview.first).toMatchObject({ artifactId: 'artifact-lantern', fromZoneId: 'zone-arrival', fromIndex: 0, toZoneId: 'zone-patterns', toIndex: 1 });
    expect(preview.second).toMatchObject({ artifactId: 'artifact-radio', fromZoneId: 'zone-patterns', fromIndex: 1, toZoneId: 'zone-arrival', toIndex: 0 });
    const [arrival, patterns] = preview.zones;
    expect(arrival).toMatchObject({ zoneId: 'zone-arrival', beforeDwellMinutes: 4, afterDwellMinutes: 5, beforeObjects: 1, afterObjects: 1 });
    expect(patterns).toMatchObject({ zoneId: 'zone-patterns', beforeDwellMinutes: 11, afterDwellMinutes: 10, beforeObjects: 2, afterObjects: 2 });
  });

  it('flags a single-side conflict and blocks the swap', () => {
    const state = createSeedWorkspace();
    const { preview, request } = swapPair(state, 'artifact-lantern', 'artifact-sample-book');
    expect(preview.canSwap).toBe(false);
    expect(preview.errors).toHaveLength(1);
    expect(preview.errors[0].detail).toContain('low-light');
    expect(preview.warnings.some((finding) => finding.detail.includes('seated'))).toBe(true);
    expect(applyArtifactSwap(state, request)).toBeNull();
    expect(placedIds(state, 'zone-arrival')).toEqual(['artifact-lantern']);
    expect(placedIds(state, 'zone-patterns')).toEqual(['artifact-sample-book', 'artifact-radio']);
  });

  it('reports conflicts on both sides when each target breaks a rule', () => {
    const seed = createSeedWorkspace();
    const state: WorkspaceState = {
      ...seed,
      zones: seed.zones.map((zone) => {
        if (zone.id === 'zone-patterns') return { ...zone, lowLight: false };
        if (zone.id === 'zone-common') return { ...zone, artifactIds: ['artifact-press'] };
        if (zone.id === 'zone-after') return { ...zone, capacityMinutes: 25, artifactIds: ['artifact-bowl', 'artifact-tape', 'artifact-quilt'] };
        return zone;
      }),
    };
    const { preview, request } = swapPair(state, 'artifact-sample-book', 'artifact-quilt');
    expect(preview.canSwap).toBe(false);
    expect(preview.errors).toHaveLength(2);
    expect(preview.first.findings.some((finding) => finding.type === 'error')).toBe(true);
    expect(preview.second.findings.some((finding) => finding.type === 'error')).toBe(true);
    expect(applyArtifactSwap(state, request)).toBeNull();
  });

  it('blocks a swap that would push a zone over dwell capacity', () => {
    const seed = createSeedWorkspace();
    const state: WorkspaceState = {
      ...seed,
      zones: seed.zones.map((zone) => zone.id === 'zone-after' ? { ...zone, capacityMinutes: 12 } : zone),
    };
    const { preview, request } = swapPair(state, 'artifact-press', 'artifact-bowl');
    expect(preview.canSwap).toBe(false);
    expect(preview.errors.some((finding) => finding.id === 'swap-capacity-zone-after')).toBe(true);
    expect(applyArtifactSwap(state, request)).toBeNull();
  });

  it('returns no plan when an object is missing, unplaced, or in the same zone', () => {
    const state = createSeedWorkspace();
    expect(planArtifactSwap(state, 'artifact-gloves', 'artifact-lantern')).toBeNull();
    expect(planArtifactSwap(state, 'artifact-unknown', 'artifact-lantern')).toBeNull();
    expect(planArtifactSwap(state, 'artifact-lantern', 'artifact-lantern')).toBeNull();
    expect(planArtifactSwap(state, 'artifact-sample-book', 'artifact-radio')).toBeNull();
  });
});

describe('swap application', () => {
  it('swaps both objects atomically and preserves zone order', () => {
    const state = createSeedWorkspace();
    const { request } = swapPair(state, 'artifact-lantern', 'artifact-radio');
    const next = applyArtifactSwap(state, request);
    expect(next).not.toBeNull();
    expect(placedIds(next!, 'zone-arrival')).toEqual(['artifact-radio']);
    expect(placedIds(next!, 'zone-patterns')).toEqual(['artifact-sample-book', 'artifact-lantern']);
    expect(placedIds(next!, 'zone-common')).toEqual(['artifact-press', 'artifact-quilt']);
    expect(placedIds(next!, 'zone-after')).toEqual(['artifact-bowl', 'artifact-tape']);
    const placed = next!.zones.flatMap((zone) => zone.artifactIds);
    expect(new Set(placed).size).toBe(placed.length);
    expect(placed).toHaveLength(state.zones.flatMap((zone) => zone.artifactIds).length);
  });

  it('rejects a stale request when the plan changed before confirmation', () => {
    const state = createSeedWorkspace();
    const { request } = swapPair(state, 'artifact-lantern', 'artifact-radio');
    const moved: WorkspaceState = {
      ...state,
      zones: state.zones.map((zone) => {
        if (zone.id === 'zone-arrival') return { ...zone, artifactIds: [] };
        if (zone.id === 'zone-after') return { ...zone, artifactIds: ['artifact-lantern', ...zone.artifactIds] };
        return zone;
      }),
    };
    expect(applyArtifactSwap(moved, request)).toBeNull();
    const reordered: WorkspaceState = {
      ...state,
      zones: state.zones.map((zone) => zone.id === 'zone-patterns' ? { ...zone, artifactIds: ['artifact-radio', 'artifact-sample-book'] } : zone),
    };
    expect(applyArtifactSwap(reordered, request)).toBeNull();
  });

  it('rejects the swap when a swapped object changes before confirmation', () => {
    const state = createSeedWorkspace();
    const { request } = swapPair(state, 'artifact-lantern', 'artifact-radio');
    const longer: WorkspaceState = {
      ...state,
      artifacts: state.artifacts.map((artifact) => artifact.id === 'artifact-lantern' ? { ...artifact, dwellMinutes: 6 } : artifact),
    };
    expect(applyArtifactSwap(longer, request)).toBeNull();
    expect(placedIds(longer, 'zone-arrival')).toEqual(['artifact-lantern']);
    expect(placedIds(longer, 'zone-patterns')).toEqual(['artifact-sample-book', 'artifact-radio']);
    const sensitized: WorkspaceState = {
      ...state,
      artifacts: state.artifacts.map((artifact) => artifact.id === 'artifact-radio' ? { ...artifact, sensitivity: 'low-light' as const } : artifact),
    };
    expect(applyArtifactSwap(sensitized, request)).toBeNull();
  });

  it('rejects the swap when a zone-mate object changes the capacity math', () => {
    const state = createSeedWorkspace();
    const { request } = swapPair(state, 'artifact-lantern', 'artifact-radio');
    const edited: WorkspaceState = {
      ...state,
      artifacts: state.artifacts.map((artifact) => artifact.id === 'artifact-sample-book' ? { ...artifact, dwellMinutes: 9 } : artifact),
    };
    expect(applyArtifactSwap(edited, request)).toBeNull();
    expect(placedIds(edited, 'zone-arrival')).toEqual(['artifact-lantern']);
    expect(placedIds(edited, 'zone-patterns')).toEqual(['artifact-sample-book', 'artifact-radio']);
  });

  it('rejects the swap when zone capacity changes before confirmation', () => {
    const state = createSeedWorkspace();
    const { request } = swapPair(state, 'artifact-lantern', 'artifact-radio');
    const tightened: WorkspaceState = {
      ...state,
      zones: state.zones.map((zone) => zone.id === 'zone-arrival' ? { ...zone, capacityMinutes: 6 } : zone),
    };
    expect(applyArtifactSwap(tightened, request)).toBeNull();
    const crowded: WorkspaceState = {
      ...state,
      zones: state.zones.map((zone) => zone.id === 'zone-patterns' ? { ...zone, maxObjects: 1 } : zone),
    };
    expect(applyArtifactSwap(crowded, request)).toBeNull();
    expect(placedIds(tightened, 'zone-arrival')).toEqual(['artifact-lantern']);
    expect(placedIds(tightened, 'zone-patterns')).toEqual(['artifact-sample-book', 'artifact-radio']);
  });

  it('rejects the swap when zone rules change before confirmation', () => {
    const state = createSeedWorkspace();
    const { request } = swapPair(state, 'artifact-lantern', 'artifact-radio');
    const darkened: WorkspaceState = {
      ...state,
      zones: state.zones.map((zone) => zone.id === 'zone-patterns' ? { ...zone, lowLight: false } : zone),
    };
    expect(applyArtifactSwap(darkened, request)).toBeNull();
    const unseated: WorkspaceState = {
      ...state,
      zones: state.zones.map((zone) => zone.id === 'zone-arrival' ? { ...zone, hasSeating: true } : zone),
    };
    expect(applyArtifactSwap(unseated, request)).toBeNull();
    expect(placedIds(darkened, 'zone-arrival')).toEqual(['artifact-lantern']);
    expect(placedIds(darkened, 'zone-patterns')).toEqual(['artifact-sample-book', 'artifact-radio']);
  });

  it('still applies when only unrelated records change before confirmation', () => {
    const state = createSeedWorkspace();
    const { request } = swapPair(state, 'artifact-lantern', 'artifact-radio');
    const unrelated: WorkspaceState = {
      ...state,
      artifacts: state.artifacts.map((artifact) => artifact.id === 'artifact-quilt' ? { ...artifact, title: 'Renamed Quilt', dwellMinutes: 9 } : artifact),
      preferences: { ...state.preferences, groupSize: 12 },
    };
    const next = applyArtifactSwap(unrelated, request);
    expect(next).not.toBeNull();
    expect(placedIds(next!, 'zone-arrival')).toEqual(['artifact-radio']);
    expect(placedIds(next!, 'zone-patterns')).toEqual(['artifact-sample-book', 'artifact-lantern']);
  });

  it('ignores a repeated confirmation without duplicating objects', () => {
    const state = createSeedWorkspace();
    const { request } = swapPair(state, 'artifact-lantern', 'artifact-radio');
    const first = applyArtifactSwap(state, request);
    expect(first).not.toBeNull();
    expect(applyArtifactSwap(first!, request)).toBeNull();
    const placed = first!.zones.flatMap((zone) => zone.artifactIds);
    expect(new Set(placed).size).toBe(placed.length);
    expect(placed.filter((id) => id === 'artifact-lantern')).toHaveLength(1);
    expect(placed.filter((id) => id === 'artifact-radio')).toHaveLength(1);
  });
});

describe('swap through the workspace reducer', () => {
  it('applies a confirmed swap in one stamped transition', () => {
    const state = createSeedWorkspace();
    const { request } = swapPair(state, 'artifact-lantern', 'artifact-radio');
    const next = workspaceReducer(state, { type: 'placement/swap', request });
    expect(next).not.toBe(state);
    expect(placedIds(next, 'zone-arrival')).toEqual(['artifact-radio']);
    expect(placedIds(next, 'zone-patterns')).toEqual(['artifact-sample-book', 'artifact-lantern']);
    expect(next.lastSavedAt).not.toBe(state.lastSavedAt);
  });

  it('leaves state untouched when the swap is rejected', () => {
    const state = createSeedWorkspace();
    const { request } = swapPair(state, 'artifact-lantern', 'artifact-sample-book');
    expect(workspaceReducer(state, { type: 'placement/swap', request })).toBe(state);
  });

  it('leaves state untouched when the plan version changed after the request was captured', () => {
    const state = createSeedWorkspace();
    const { request } = swapPair(state, 'artifact-lantern', 'artifact-radio');
    const edited: WorkspaceState = {
      ...state,
      artifacts: state.artifacts.map((artifact) => artifact.id === 'artifact-lantern' ? { ...artifact, dwellMinutes: 6 } : artifact),
    };
    expect(workspaceReducer(edited, { type: 'placement/swap', request })).toBe(edited);
  });

  it('regresses a ready project back to review after a swap', () => {
    const seed = createSeedWorkspace();
    const state: WorkspaceState = { ...seed, project: { ...seed.project, stage: 'ready' } };
    const { request } = swapPair(state, 'artifact-lantern', 'artifact-radio');
    const next = workspaceReducer(state, { type: 'placement/swap', request });
    expect(next.project.stage).toBe('review');
  });
});

describe('swap and derived state', () => {
  it('keeps the unplaced queue, readiness, and snapshot on final positions', () => {
    const seed = createSeedWorkspace();
    const resolved: WorkspaceState = {
      ...seed,
      issues: seed.issues.map((issue) => ({ ...issue, status: 'resolved' as const })),
    };
    const { request } = swapPair(resolved, 'artifact-lantern', 'artifact-radio');
    const next = applyArtifactSwap(resolved, request);
    expect(next).not.toBeNull();

    expect(getUnplacedArtifacts(next!.artifacts, next!.zones).map((artifact) => artifact.id))
      .toEqual(getUnplacedArtifacts(resolved.artifacts, resolved.zones).map((artifact) => artifact.id));

    const analysis = analyzeJourney(next!.artifacts, next!.zones);
    expect(analysis.zones.find((zone) => zone.zoneId === 'zone-arrival')?.dwellMinutes).toBe(5);
    expect(analysis.zones.find((zone) => zone.zoneId === 'zone-patterns')?.dwellMinutes).toBe(10);

    const readiness = evaluateReadiness(next!, analysis);
    expect(readiness.ready).toBe(true);
    const snapshot = buildSnapshot(next!, analysis, readiness);
    expect(snapshot.zones.find((zone) => zone.id === 'zone-arrival')?.artifacts.map((artifact) => artifact.id)).toEqual(['artifact-radio']);
    expect(snapshot.zones.find((zone) => zone.id === 'zone-patterns')?.artifacts.map((artifact) => artifact.id)).toEqual(['artifact-sample-book', 'artifact-lantern']);
  });

  it('persists the swapped plan so a reload restores final positions', () => {
    const state = createSeedWorkspace();
    const { request } = swapPair(state, 'artifact-lantern', 'artifact-radio');
    const next = workspaceReducer(state, { type: 'placement/swap', request });
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } as unknown as Storage;
    expect(saveWorkspace(next, storage)).toBe(true);
    expect(values.has(STORAGE_KEY)).toBe(true);
    const restored = loadWorkspace(storage);
    expect(placedIds(restored, 'zone-arrival')).toEqual(['artifact-radio']);
    expect(placedIds(restored, 'zone-patterns')).toEqual(['artifact-sample-book', 'artifact-lantern']);
  });
});
