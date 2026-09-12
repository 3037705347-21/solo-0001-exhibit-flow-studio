import { describe, expect, it } from 'vitest';
import { analyzeJourney } from '../domain/journeyAnalysis';
import { readinessDrift } from '../domain/readinessTracking';
import { evaluateReadiness } from '../domain/reviewRules';
import type { WorkspaceState } from '../domain/models';
import { workspaceReducer } from './reducer';
import { createSeedWorkspace } from './seed';

function runCheck(state: WorkspaceState): WorkspaceState {
  const result = evaluateReadiness(state, analyzeJourney(state.artifacts, state.zones));
  return workspaceReducer(state, { type: 'project/readiness', ready: result.ready, checkedAt: result.checkedAt, result });
}

describe('readiness state consistency', () => {
  it('stores the checked result with its dependency facts', () => {
    const state = runCheck(createSeedWorkspace());
    expect(state.readiness?.ready).toBe(false);
    expect(state.readiness?.facts.length).toBeGreaterThan(0);
    expect(state.project.stage).toBe('review');
    expect(state.project.lastReadinessCheck).toBe(state.readiness?.checkedAt);
  });

  it('keeps a fresh ready verdict while nothing changes', () => {
    const resolved: WorkspaceState = {
      ...createSeedWorkspace(),
      issues: createSeedWorkspace().issues.map((issue) => ({ ...issue, status: 'resolved' as const })),
    };
    const ready = runCheck(resolved);
    expect(ready.project.stage).toBe('ready');
    expect(readinessDrift(ready)?.stale).toBe(false);
  });

  it('regresses a ready project and exposes the stale record after an edit from another module', () => {
    const resolved: WorkspaceState = {
      ...createSeedWorkspace(),
      issues: createSeedWorkspace().issues.map((issue) => ({ ...issue, status: 'resolved' as const })),
    };
    const ready = runCheck(resolved);
    const bowl = ready.artifacts.find((artifact) => artifact.id === 'artifact-bowl')!;
    const edited = workspaceReducer(ready, { type: 'artifact/upsert', artifact: { ...bowl, dwellMinutes: 30 } });
    expect(edited.project.stage).toBe('review');
    expect(edited.readiness).toBe(ready.readiness);
    const drift = readinessDrift(edited);
    expect(drift?.stale).toBe(true);
    expect(drift?.changed).toContain('artifact:artifact-bowl');
  });

  it('resolves the drift with the same fact basis when the check is re-run', () => {
    const state = runCheck(createSeedWorkspace());
    const resolved = workspaceReducer(state, { type: 'issue/transition', issueId: 'issue-audio-transcript', status: 'resolved' });
    expect(readinessDrift(resolved)?.stale).toBe(true);
    const rechecked = runCheck(resolved);
    expect(rechecked.readiness?.ready).toBe(true);
    expect(rechecked.project.stage).toBe('ready');
    expect(readinessDrift(rechecked)?.stale).toBe(false);
  });
});
