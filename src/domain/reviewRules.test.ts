import { describe, expect, it } from 'vitest';
import { analyzeJourney } from './journeyAnalysis';
import { evaluateReadiness } from './reviewRules';
import { createSeedWorkspace } from '../state/seed';

describe('readiness rules', () => {
  it('blocks a plan with an unresolved critical finding and links to it', () => {
    const state = createSeedWorkspace();
    const readiness = evaluateReadiness(state, analyzeJourney(state.artifacts, state.zones));
    expect(readiness.ready).toBe(false);
    const critical = readiness.blockers.find((blocker) => blocker.id === 'critical-findings');
    expect(critical?.message).toContain('critical');
    expect(critical?.links).toEqual([
      { kind: 'issue', id: 'issue-audio-transcript', label: 'Add transcript beside oral history station' },
    ]);
  });
  it('clears the blocker once the critical finding is resolved', () => {
    const state = createSeedWorkspace();
    const fixed = { ...state, issues: state.issues.map((issue) => issue.severity === 'critical' ? { ...issue, status: 'resolved' as const } : issue) };
    const readiness = evaluateReadiness(fixed, analyzeJourney(fixed.artifacts, fixed.zones));
    expect(readiness.ready).toBe(true);
    expect(readiness.blockers).toHaveLength(0);
  });
  it('passes when the critical finding and all journey blockers are resolved', () => {
    const state = createSeedWorkspace();
    const clean = { ...state, issues: state.issues.map((issue) => ({ ...issue, status: 'resolved' as const })) };
    const readiness = evaluateReadiness(clean, analyzeJourney(clean.artifacts, clean.zones));
    expect(readiness.ready).toBe(true);
  });
  it('records the domain facts the verdict depends on', () => {
    const state = createSeedWorkspace();
    const readiness = evaluateReadiness(state, analyzeJourney(state.artifacts, state.zones));
    const keys = readiness.facts.map((fact) => fact.key);
    expect(keys).toContain('issue:issue-audio-transcript');
    expect(keys).toContain('artifact:artifact-lantern');
    expect(keys).toContain('zone:zone-arrival');
    expect(keys).toHaveLength(state.issues.length + state.artifacts.length + state.zones.length);
  });
  it('links journey constraint blockers to the affected zone', () => {
    const state = createSeedWorkspace();
    const crowded = {
      ...state,
      artifacts: state.artifacts.map((artifact) =>
        artifact.id === 'artifact-bowl' ? { ...artifact, sensitivity: 'low-light' as const } : artifact),
    };
    const readiness = evaluateReadiness(crowded, analyzeJourney(crowded.artifacts, crowded.zones));
    const journey = readiness.blockers.find((blocker) => blocker.id === 'journey-constraints');
    expect(journey?.message).toContain('journey constraint');
    expect(journey?.links).toContainEqual(expect.objectContaining({ kind: 'zone', id: 'zone-after' }));
  });
});
