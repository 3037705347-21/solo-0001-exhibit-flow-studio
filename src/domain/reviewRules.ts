import { previewSnapshotDependencies, snapshotNodeId } from './lineage';
import type { JourneyAnalysis, ReadinessResult, ReviewIssue, Snapshot, WorkspaceState } from './models';

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

export interface ExportCheck {
  ready: boolean;
  blockers: string[];
  cautions: string[];
  needsReviewCount: number;
  deletedCount: number;
}

/**
 * Pre-export dependency check over the prospective package: the reference
 * closure must not contain deleted sources, and stale records are surfaced as
 * re-review cautions rather than shown as fully valid.
 */
export function checkExportDependencies(state: WorkspaceState, generatedAt: string): ExportCheck {
  const nodeId = snapshotNodeId(generatedAt);
  const check = previewSnapshotDependencies(state, nodeId);
  return {
    ready: check.deletedSources.length === 0,
    blockers: check.blockers,
    cautions: check.cautions,
    needsReviewCount: check.needsReview.length,
    deletedCount: check.deletedSources.length,
  };
}

export function buildSnapshot(state: WorkspaceState, analysis: JourneyAnalysis, readiness: ReadinessResult): Snapshot {
  if (!readiness.ready) {
    throw new Error('A snapshot can only be created when the plan passes readiness checks.');
  }
  const artifactById = new Map(state.artifacts.map((artifact) => [artifact.id, artifact]));
  const generatedAt = readiness.checkedAt;
  const nodeId = snapshotNodeId(generatedAt);
  const dependencyCheck = previewSnapshotDependencies(state, nodeId);
  const dependencies = dependencyCheck.dependencies;
  return {
    schemaVersion: 1,
    generatedAt,
    project: { ...state.project, stage: 'ready', lastReadinessCheck: generatedAt },
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
    unresolvedIssues: state.issues.filter((issue) => issue.status !== 'resolved'),
    lineage: {
      snapshotNodeId: nodeId,
      dependencyCount: dependencies.length,
      needsReviewCount: dependencyCheck.needsReview.length,
      importedCount: dependencies.filter((dependency) => dependency.origin === 'import').length,
      dependencies,
    },
  };
}

export function issueProgress(issues: ReviewIssue[]): number {
  if (issues.length === 0) return 1;
  return issues.filter((issue) => issue.status === 'resolved').length / issues.length;
}
