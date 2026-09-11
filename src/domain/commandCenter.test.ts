import { describe, expect, it } from 'vitest';
import { buildCapacityRisks, buildCommandCenter, buildCoverage, rankRisks } from './commandCenter';
import { analyzeJourney } from './journeyAnalysis';
import { evaluateReadiness } from './reviewRules';
import { createSeedWorkspace } from '../state/seed';
import type { WorkspaceState } from './models';

function emptyWorkspace(): WorkspaceState {
  const seed = createSeedWorkspace();
  return {
    ...seed,
    project: { ...seed.project, stage: 'draft', openingDate: '', lastReadinessCheck: undefined },
    artifacts: [],
    zones: [],
    issues: [],
  };
}

describe('buildCommandCenter', () => {
  it('reuses the journey and readiness engines for its headline numbers', () => {
    const state = createSeedWorkspace();
    const command = buildCommandCenter(state);
    const analysis = analyzeJourney(state.artifacts, state.zones);
    const readiness = evaluateReadiness(state, analysis);
    expect(command.readiness.score).toBe(readiness.score);
    expect(command.readiness.ready).toBe(false);
    expect(command.analysis.placedCount).toBe(analysis.placedCount);
    expect(command.coverage.placedCount).toBe(7);
    expect(command.coverage.totalArtifacts).toBe(8);
    expect(command.coverage.keyPlaced).toBe(4);
    expect(command.coverage.keyTotal).toBe(4);
  });

  it('ranks unresolved critical findings ahead of journey warnings and info risks', () => {
    const command = buildCommandCenter(createSeedWorkspace());
    expect(command.risks.length).toBeGreaterThan(2);
    const levels = command.risks.map((risk) => risk.level);
    expect(levels[0]).toBe('critical');
    const sorted = rankRisks(command.risks).map((risk) => risk.level);
    expect(sorted).toEqual(levels);
    const criticalIssue = command.risks.find((risk) => risk.id === 'risk-issue-issue-audio-transcript');
    expect(criticalIssue?.to).toBe('/review?issue=issue-audio-transcript');
    expect(criticalIssue?.level).toBe('critical');
  });

  it('links capacity and key-object risks back to the journey page', () => {
    const command = buildCommandCenter(createSeedWorkspace());
    const unplacedRisk = command.risks.find((risk) => risk.id === 'risk-unplaced');
    expect(unplacedRisk?.to).toBe('/journey?artifact=artifact-gloves');
    expect(command.capacityRisks.every((zone) => zone.to.startsWith('/journey?zone='))).toBe(true);
  });

  it('reports no formal check when the project has never run the gate', () => {
    const state = createSeedWorkspace();
    const command = buildCommandCenter({ ...state, project: { ...state.project, lastReadinessCheck: undefined } });
    expect(command.lastCheck.status).toBe('none');
    expect(command.risks.some((risk) => risk.id === 'risk-no-check')).toBe(true);
  });

  it('treats a ready stage with a recorded check as a current passing gate', () => {
    const state = createSeedWorkspace();
    const checkedAt = '2026-09-05T10:00:00.000Z';
    const resolved: WorkspaceState = {
      ...state,
      issues: state.issues.map((issue) => ({ ...issue, status: 'resolved' as const })),
      artifacts: state.artifacts.map((artifact) => ({ ...artifact, isKeyObject: false })),
      zones: state.zones.map((zone, index) => index === 0 ? { ...zone, artifactIds: [...zone.artifactIds, 'artifact-gloves'] } : zone),
      project: { ...state.project, stage: 'ready', lastReadinessCheck: checkedAt },
    };
    const command = buildCommandCenter(resolved);
    expect(command.readiness.ready).toBe(true);
    expect(command.lastCheck.status).toBe('passed');
    expect(command.lastCheck.checkedAt).toBe(checkedAt);
  });

  it('marks a recorded passing check as needing refresh once blocking changes regress the stage', () => {
    const state = createSeedWorkspace();
    const checkedAt = '2026-09-05T10:00:00.000Z';
    // Stage back in review but the live engine clears; the recorded pass is stale.
    const live: WorkspaceState = {
      ...state,
      issues: state.issues.map((issue) => ({ ...issue, status: 'resolved' as const })),
      project: { ...state.project, stage: 'review', lastReadinessCheck: checkedAt },
    };
    const command = buildCommandCenter(live);
    expect(command.readiness.ready).toBe(true);
    expect(command.lastCheck.status).toBe('needs-refresh');
  });

  it('keeps the draft stage and reports a blocked check when the gate was run against blockers', () => {
    const state = createSeedWorkspace();
    const command = buildCommandCenter({
      ...state,
      project: { ...state.project, stage: 'review', lastReadinessCheck: '2026-09-02T09:00:00.000Z' },
    });
    expect(command.stage).toBe('review');
    expect(command.lastCheck.status).toBe('blocked');
  });

  it('reports a single informational risk when a complete plan has never run the gate', () => {
    const state = createSeedWorkspace();
    const complete: WorkspaceState = {
      ...state,
      issues: state.issues.map((issue) => ({ ...issue, status: 'resolved' as const })),
      zones: state.zones.map((zone, index) => index === 0 ? { ...zone, artifactIds: [...zone.artifactIds, 'artifact-gloves'] } : zone),
      project: { ...state.project, stage: 'review', lastReadinessCheck: undefined },
    };
    const command = buildCommandCenter(complete);
    expect(command.readiness.ready).toBe(true);
    expect(command.readiness.score).toBe(100);
    expect(command.risks.map((risk) => risk.id)).toEqual(['risk-no-check']);
    expect(command.risks[0].level).toBe('info');
    expect(command.capacityRisks).toEqual([]);
  });

  it('renders the draft stage without inventing a passing score or check date', () => {
    const state = emptyWorkspace();
    const command = buildCommandCenter({ ...state, project: { ...state.project, openingDate: '2027-03-18' } });
    expect(command.stage).toBe('draft');
    expect(command.lastCheck.status).toBe('none');
    expect(command.lastCheck.passed).toBe(false);
    expect(command.daysToOpening).toBeGreaterThan(0);
  });
});

describe('empty workspace', () => {
  it('flags the workspace as empty and drives users to the collection', () => {
    const command = buildCommandCenter(emptyWorkspace());
    expect(command.empty).toBe(true);
    expect(command.coverage.placedCount).toBe(0);
    expect(command.coverage.placementRatio).toBe(1);
    expect(command.risks).toHaveLength(2);
    expect(command.risks[0].id).toBe('risk-empty-collection');
    expect(command.risks[0].to).toBe('/collection');
    expect(command.risks.some((risk) => risk.id === 'risk-no-check')).toBe(true);
    expect(command.capacityRisks).toEqual([]);
  });

  it('does not list story-role risks when there are no artifacts', () => {
    const command = buildCommandCenter(emptyWorkspace());
    expect(command.risks.some((risk) => risk.id.startsWith('risk-role-'))).toBe(false);
  });
});

describe('coverage and capacity derivation', () => {
  it('buildCoverage reports missing roles and unplaced key objects', () => {
    const state = createSeedWorkspace();
    const empty = emptyWorkspace();
    const emptyCoverage = buildCoverage(empty, analyzeJourney(empty.artifacts, empty.zones));
    expect(emptyCoverage.missingRoles).toHaveLength(4);
    const coverage = buildCoverage(state, analyzeJourney(state.artifacts, state.zones));
    expect(coverage.missingRoles).toEqual([]);
    expect(coverage.rolesCovered).toHaveLength(4);
  });

  it('flags zones at or over dwell capacity with the correct level', () => {
    const state = createSeedWorkspace();
    const overloaded: WorkspaceState = {
      ...state,
      zones: state.zones.map((zone) => zone.id === 'zone-arrival'
        ? { ...zone, capacityMinutes: 2, maxObjects: 1 }
        : zone),
    };
    const analysis = analyzeJourney(overloaded.artifacts, overloaded.zones);
    const risks = buildCapacityRisks(overloaded, analysis);
    const arrival = risks.find((zone) => zone.zoneId === 'zone-arrival');
    expect(arrival?.level).toBe('critical');
    expect(arrival?.to).toContain('/journey?zone=zone-arrival');
  });

  it('marks zones pressured by the saved scenario and points those links at insights', () => {
    const state = createSeedWorkspace();
    const analysis = analyzeJourney(state.artifacts, state.zones);
    const risks = buildCapacityRisks(state, analysis, ['zone-after']);
    const after = risks.find((zone) => zone.zoneId === 'zone-after');
    expect(after?.pressured).toBe(true);
    expect(after?.to).toBe('/insights?zone=zone-after');
  });
});
