import { collectReadinessFacts } from './readinessTracking';
import type { JourneyAnalysis, ReadinessBlocker, ReadinessLink, ReadinessResult, ReviewIssue, Snapshot, WorkspaceState } from './models';

function dedupeLinks(links: ReadinessLink[]): ReadinessLink[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${link.kind}:${link.id ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function evaluateReadiness(state: WorkspaceState, analysis: JourneyAnalysis, at = new Date()): ReadinessResult {
  const blockers: ReadinessBlocker[] = [];
  const cautions: string[] = [];
  const unresolvedCritical = state.issues.filter(
    (issue) => issue.severity === 'critical' && issue.status !== 'resolved',
  );
  const unresolvedWarnings = state.issues.filter(
    (issue) => issue.severity === 'warning' && issue.status !== 'resolved',
  );

  if (analysis.blockingCount > 0) {
    const errorFindings = analysis.findings.filter((finding) => finding.type === 'error');
    blockers.push({
      id: 'journey-constraints',
      message: `${analysis.blockingCount} blocking journey constraint${analysis.blockingCount === 1 ? ' remains' : 's remain'}.`,
      links: dedupeLinks(errorFindings.map((finding) => {
        if (finding.zoneId) {
          const zone = state.zones.find((candidate) => candidate.id === finding.zoneId);
          return { kind: 'zone', id: finding.zoneId, label: zone ? `${finding.title} · ${zone.shortLabel}` : finding.title };
        }
        if (finding.artifactId) return { kind: 'artifact' as const, id: finding.artifactId, label: finding.title };
        return { kind: 'journey' as const, label: finding.title };
      })),
    });
  }
  if (unresolvedCritical.length > 0) {
    blockers.push({
      id: 'critical-findings',
      message: `${unresolvedCritical.length} critical review finding${unresolvedCritical.length === 1 ? ' remains' : 's remain'} unresolved.`,
      links: unresolvedCritical.map((issue) => ({ kind: 'issue', id: issue.id, label: issue.title })),
    });
  }
  if (analysis.placedCount === 0) {
    blockers.push({
      id: 'empty-journey',
      message: 'The visitor journey has no placed objects.',
      links: [{ kind: 'journey', label: 'Open the journey planner' }],
    });
  }
  if (analysis.keyObjectCoverage < 1) {
    const placedIds = new Set(state.zones.flatMap((zone) => zone.artifactIds));
    const unplacedKeyObjects = state.artifacts.filter((artifact) => artifact.isKeyObject && !placedIds.has(artifact.id));
    blockers.push({
      id: 'key-objects',
      message: 'Every key object must be placed in the journey.',
      links: dedupeLinks(unplacedKeyObjects.map((artifact) => ({ kind: 'artifact' as const, id: artifact.id, label: artifact.title }))),
    });
  }
  if (analysis.roleCoverage < 1) {
    blockers.push({
      id: 'role-coverage',
      message: 'The planned journey does not cover every narrative role.',
      links: [{ kind: 'journey', label: 'Adjust placements in the journey planner' }],
    });
  }

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
    facts: collectReadinessFacts(state),
  };
}

export function buildSnapshot(state: WorkspaceState, analysis: JourneyAnalysis, readiness: ReadinessResult): Snapshot {
  if (!readiness.ready) {
    throw new Error('A snapshot can only be created when the plan passes readiness checks.');
  }
  const artifactById = new Map(state.artifacts.map((artifact) => [artifact.id, artifact]));
  return {
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
    unresolvedIssues: state.issues.filter((issue) => issue.status !== 'resolved'),
  };
}

export function issueProgress(issues: ReviewIssue[]): number {
  if (issues.length === 0) return 1;
  return issues.filter((issue) => issue.status === 'resolved').length / issues.length;
}
