import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReadinessResult } from '../../../domain/models';
import { createSeedWorkspace } from '../../../state/seed';
import { evaluateWorkspaceReadiness, useReadinessCheck } from './useReadinessCheck';

describe('useReadinessCheck', () => {
  it('derives the initial readiness result from the workspace on mount', () => {
    const state = createSeedWorkspace();
    const expected = evaluateWorkspaceReadiness(state);
    const runCheck = vi.fn();

    const { result } = renderHook(() => useReadinessCheck(state, runCheck));

    expect(result.current.readiness.ready).toBe(expected.ready);
    expect(result.current.readiness.score).toBe(expected.score);
    expect(result.current.readiness.blockers).toEqual(expected.blockers);
    expect(typeof result.current.readiness.checkedAt).toBe('string');
    expect(runCheck).not.toHaveBeenCalled();
  });

  it('updates the displayed result with the value the check action returns', () => {
    const state = createSeedWorkspace();
    const rechecked: ReadinessResult = {
      ready: true,
      score: 100,
      blockers: [],
      cautions: [],
      checkedAt: '2026-09-10T10:00:00.000Z',
    };
    const runCheck = vi.fn(() => rechecked);

    const { result } = renderHook(() => useReadinessCheck(state, runCheck));
    expect(result.current.readiness.ready).toBe(evaluateWorkspaceReadiness(state).ready);

    act(() => result.current.check());

    expect(runCheck).toHaveBeenCalledTimes(1);
    expect(result.current.readiness).toBe(rechecked);
  });
});
