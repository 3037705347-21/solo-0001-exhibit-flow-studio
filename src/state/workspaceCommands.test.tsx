import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { stageBatchPlacement } from '../domain/batchPlacement';
import { getUnplacedArtifacts } from '../domain/journeyAnalysis';
import { WorkspaceProvider, useWorkspace } from './WorkspaceContext';

const wrapper = ({ children }: { children: ReactNode }) => <WorkspaceProvider>{children}</WorkspaceProvider>;

beforeEach(() => {
  localStorage.clear();
});

describe('commitBatchPlacement command', () => {
  it('applies a feasible batch and persists the result', () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    const plan = stageBatchPlacement(result.current.state, [
      { artifactId: 'artifact-gloves', zoneId: 'zone-arrival' },
    ], 'batch-command');
    let commit: ReturnType<typeof result.current.commitBatchPlacement> | undefined;
    act(() => { commit = result.current.commitBatchPlacement(plan); });
    expect(commit?.ok).toBe(true);
    expect(result.current.state.zones.find((zone) => zone.id === 'zone-arrival')!.artifactIds)
      .toEqual(['artifact-lantern', 'artifact-gloves']);
    expect(getUnplacedArtifacts(result.current.state.artifacts, result.current.state.zones)).toEqual([]);
  });

  it('keeps repeated submissions idempotent', () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    const plan = stageBatchPlacement(result.current.state, [
      { artifactId: 'artifact-gloves', zoneId: 'zone-arrival' },
    ], 'batch-command');
    act(() => { result.current.commitBatchPlacement(plan); });
    const afterFirst = result.current.state;
    let replay: ReturnType<typeof result.current.commitBatchPlacement> | undefined;
    act(() => { replay = result.current.commitBatchPlacement(plan); });
    expect(replay?.ok).toBe(true);
    expect(replay?.value?.alreadyApplied).toBe(true);
    expect(result.current.state).toBe(afterFirst);
  });

  it('refuses a batch when the journey changed after staging', () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    const plan = stageBatchPlacement(result.current.state, [
      { artifactId: 'artifact-gloves', zoneId: 'zone-arrival' },
    ], 'batch-command');
    act(() => { result.current.assignArtifact('artifact-gloves', 'zone-patterns'); });
    let commit: ReturnType<typeof result.current.commitBatchPlacement> | undefined;
    act(() => { commit = result.current.commitBatchPlacement(plan); });
    expect(commit?.ok).toBe(false);
    expect(commit?.value?.stale).toBe(true);
    expect(result.current.state.zones.find((zone) => zone.id === 'zone-patterns')!.artifactIds)
      .toContain('artifact-gloves');
  });

  it('refuses a batch that still has blocked candidates', () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    const plan = stageBatchPlacement(result.current.state, [
      { artifactId: 'artifact-sample-book', zoneId: 'zone-arrival' },
    ], 'batch-command');
    let commit: ReturnType<typeof result.current.commitBatchPlacement> | undefined;
    act(() => { commit = result.current.commitBatchPlacement(plan); });
    expect(commit?.ok).toBe(false);
    expect(commit?.value?.blockedCount).toBe(1);
    expect(result.current.state.zones.find((zone) => zone.id === 'zone-patterns')!.artifactIds)
      .toContain('artifact-sample-book');
  });
});
