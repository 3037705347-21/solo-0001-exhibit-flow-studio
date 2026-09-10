import { describe, expect, it } from 'vitest';
import { analyzeJourney } from './journeyAnalysis';
import { createSeedWorkspace } from '../state/seed';

describe('journey analysis', () => {
  it('finds low-light conflicts and missing roles', () => {
    const state = createSeedWorkspace();
    const analysis = analyzeJourney(state.artifacts, state.zones.map((zone) => zone.id === 'zone-patterns' ? { ...zone, lowLight: false } : zone));
    expect(analysis.findings.some((finding) => finding.id.startsWith('light-'))).toBe(true);
    expect(analysis.roleCoverage).toBe(1);
  });
  it('reports key object coverage when a key object is unplaced', () => {
    const state = createSeedWorkspace();
    const analysis = analyzeJourney(state.artifacts, state.zones.map((zone) => zone.id === 'zone-common' ? { ...zone, artifactIds: ['artifact-press'] } : zone));
    expect(analysis.keyObjectCoverage).toBeLessThan(1);
    expect(analysis.blockingCount).toBeGreaterThan(0);
  });
});
