import { evaluateReadiness } from '../../../domain/reviewRules';
import { analyzeJourney } from '../../../domain/journeyAnalysis';
import type { ReadinessResult, WorkspaceState } from '../../../domain/models';
import { useCallback, useState } from 'react';

/** Derives the readiness result shown on the card without dispatching (used for first paint). */
export function evaluateWorkspaceReadiness(state: WorkspaceState): ReadinessResult {
  return evaluateReadiness(state, analyzeJourney(state.artifacts, state.zones));
}

/**
 * Owns the readiness result displayed on the review desk. The initial value is
 * derived synchronously so the card renders populated on mount; running a check
 * delegates to the workspace action, which also records the check in the state.
 */
export function useReadinessCheck(state: WorkspaceState, runCheck: () => ReadinessResult) {
  const [readiness, setReadiness] = useState<ReadinessResult>(() => evaluateWorkspaceReadiness(state));

  const check = useCallback(() => {
    setReadiness(runCheck());
  }, [runCheck]);

  return { readiness, check };
}
