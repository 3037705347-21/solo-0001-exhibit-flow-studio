import type { ConstraintFinding, JourneyAnalysis, ReadinessResult, ReviewIssue } from './models';

export interface ReadinessNarrative {
  headline: string;
  subhead: string;
  nextActions: string[];
  completed: string[];
}

export function explainReadiness(result: ReadinessResult, analysis: JourneyAnalysis, issues: ReviewIssue[]): ReadinessNarrative {
  const completed: string[] = [];
  const nextActions: string[] = [];
  if (analysis.placedCount > 0) completed.push(`${analysis.placedCount} objects are placed in the visitor journey.`);
  if (analysis.keyObjectCoverage === 1) completed.push('All key objects have a planned location.');
  if (analysis.roleCoverage === 1) completed.push('The narrative arc covers all four roles.');
  if (issues.length && issues.every((issue) => issue.status === 'resolved')) completed.push('Every review finding is resolved.');
  if (!result.ready) {
    result.blockers.forEach((blocker) => nextActions.push(blocker));
    result.cautions.slice(0, 2).forEach((caution) => nextActions.push(caution));
    return { headline: 'A few decisions remain', subhead: 'Resolve the blockers below, then run the check again.', nextActions, completed };
  }
  result.cautions.forEach((caution) => nextActions.push(caution));
  return { headline: 'Ready to share', subhead: nextActions.length ? 'The plan passes the gate; these are useful refinements.' : 'The plan passes the gate with no follow-up actions.', nextActions, completed };
}

export function groupFindings(findings: ConstraintFinding[]): Record<ConstraintFinding['type'], ConstraintFinding[]> {
  return {
    error: findings.filter((finding) => finding.type === 'error'),
    warning: findings.filter((finding) => finding.type === 'warning'),
    notice: findings.filter((finding) => finding.type === 'notice'),
  };
}

export function findingAnchor(finding: ConstraintFinding): string {
  if (finding.artifactId) return `artifact:${finding.artifactId}`;
  if (finding.zoneId) return `zone:${finding.zoneId}`;
  return 'journey:global';
}
