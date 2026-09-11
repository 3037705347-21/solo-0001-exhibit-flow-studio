import { summarizeHistory } from './issueHistory';
import type { JourneyAnalysis, ReadinessResult, ReviewIssue, ReviewIssueSummary, Snapshot, WorkspaceState } from './models';

function stripEvents(issue: ReviewIssue): ReviewIssueSummary {
  const { events: _events, ...summary } = issue;
  return summary;
}

export function evaluateReadiness(state: WorkspaceState, analysis: JourneyAnalysis, at = new Date()): ReadinessResult {
  const blockers: string[] = [];
  const cautions: string[] = [];
  const unresolvedCritical = state.issues.filter(
    (issue) => issue.severity === 'critical' && issue.status !== 'resolved',
  );
  const unresolvedWarnings = state.issues.filter(
    (issue) => issue.severity === 'warning' && issue.status !== 'resolved',
  );

  if (analysis.blockingCount > 0) {
    blockers.push(`${analysis.blockingCount} blocking journey constraint${analysis.blockingCount === 1 ? '' : 's'} remain.`);
  }
  if (unresolvedCritical.length > 0) {
    blockers.push(`${unresolvedCritical.length} critical review finding${unresolvedCritical.length === 1 ? '' : 's'} remain unresolved.`);
  }
  if (analysis.placedCount === 0) blockers.push('The visitor journey has no placed objects.');
  if (analysis.keyObjectCoverage < 1) blockers.push('Every key object must be placed in the journey.');
  if (analysis.roleCoverage < 1) blockers.push('The planned journey does not cover every narrative role.');

  if (analysis.warningCount > 0) cautions.push(`${analysis.warningCount} journey warning${analysis.warningCount === 1 ? '' : 's'} should be reviewed.`);
  if (unresolvedWarnings.length > 0) cautions.push(`${unresolvedWarnings.length} non-critical review finding${unresolvedWarnings.length === 1 ? '' : 's'} remain open.`);
  if (analysis.unplacedCount > 0) cautions.push(`${analysis.unplacedCount} collection object${analysis.unplacedCount === 1 ? '' : 's'} are not used.`);

  const blockerPenalty = blockers.length * 18;
  const cautionPenalty = cautions.length * 6;
  const score = Math.max(0, Math.min(100, Math.round(100 - blockerPenalty - cautionPenalty)));

  return {
    ready: blockers.length === 0,
    score,
    blockers,
    cautions,
    checkedAt: at.toISOString(),
  };
}

export function buildSnapshot(
  state: WorkspaceState,
  analysis: JourneyAnalysis,
  readiness: ReadinessResult,
  options?: { includeHistory?: boolean },
): Snapshot {
  if (!readiness.ready) {
    throw new Error('A snapshot can only be created when the plan passes readiness checks.');
  }
  const artifactById = new Map(state.artifacts.map((artifact) => [artifact.id, artifact]));
  const snapshot: Snapshot = {
    schemaVersion: 1,
    generatedAt: readiness.checkedAt,
    project: { ...state.project, stage: 'ready', lastReadinessCheck: readiness.checkedAt },
    summary: {
      artifactCount: state.artifacts.length,
      zoneCount: state.zones.length,
      visitMinutes: analysis.totalDwellMinutes,
      readinessScore: readiness.score,
    },
    zones: [...state.zones]
      .sort((a, b) => a.sequence - b.sequence)
      .map((zone) => ({
        ...zone,
        artifacts: zone.artifactIds
          .map((id) => artifactById.get(id))
          .filter((artifact): artifact is NonNullable<typeof artifact> => Boolean(artifact)),
      })),
    unresolvedIssues: state.issues.filter((issue) => issue.status !== 'resolved').map(stripEvents),
  };
  if (options?.includeHistory) {
    snapshot.issueHistory = state.issues.map((issue) => {
      const { reopenCount, resolutionCount, eventCount } = summarizeHistory(issue);
      return { ...issue, historySummary: { eventCount, reopenCount, resolutionCount } };
    });
  }
  return snapshot;
}

export function issueProgress(issues: ReviewIssue[]): number {
  if (issues.length === 0) return 1;
  return issues.filter((issue) => issue.status === 'resolved').length / issues.length;
}
