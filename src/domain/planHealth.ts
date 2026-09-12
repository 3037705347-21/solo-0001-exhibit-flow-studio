import { activeIssues } from './mergeIssues';
import type { Artifact, JourneyAnalysis, ReviewIssue, WorkspaceState } from './models';

export interface PlanHealth {
  completeness: number;
  stewardship: number;
  narrative: number;
  access: number;
  overall: number;
  labels: Record<'completeness' | 'stewardship' | 'narrative' | 'access', string>;
}

function ratio(value: number, total: number): number { return total <= 0 ? 1 : Math.max(0, Math.min(1, value / total)); }

export function scorePlanHealth(state: WorkspaceState, analysis: JourneyAnalysis): PlanHealth {
  const countable = activeIssues(state.issues);
  const unresolved = countable.filter((issue) => issue.status !== 'resolved');
  const critical = unresolved.filter((issue) => issue.severity === 'critical');
  const completeness = (ratio(analysis.placedCount, state.artifacts.length) + analysis.keyObjectCoverage) / 2;
  const stewardship = Math.max(0, 1 - ratio(critical.length * 2 + unresolved.length, Math.max(1, countable.length * 2)));
  const narrative = (analysis.roleCoverage + ratio(new Set(state.artifacts.map((artifact) => artifact.narrativeRole)).size, 4)) / 2;
  const accessNeeds = state.artifacts.filter((artifact) => artifact.accessibilityNeed !== 'none');
  const access = accessNeeds.length ? ratio(accessNeeds.length - unresolvedAccess(state, analysis), accessNeeds.length) : 1;
  const overall = (completeness * .3 + stewardship * .25 + narrative * .25 + access * .2);
  return {
    completeness,
    stewardship,
    narrative,
    access,
    overall,
    labels: {
      completeness: completeness >= .8 ? 'Well mapped' : 'Needs placement',
      stewardship: stewardship >= .8 ? 'In good care' : 'Review open findings',
      narrative: narrative >= .8 ? 'Story arc present' : 'Build the arc',
      access: access >= .8 ? 'Access considered' : 'Add interpretation support',
    },
  };
}

function unresolvedAccess(state: WorkspaceState, analysis: JourneyAnalysis): number {
  const ids = new Set(analysis.findings.filter((finding) => finding.type !== 'notice' && finding.artifactId).map((finding) => finding.artifactId));
  return state.artifacts.filter((artifact) => artifact.accessibilityNeed !== 'none' && ids.has(artifact.id)).length;
}

export function healthTone(value: number): 'positive' | 'warning' | 'danger' { return value >= .8 ? 'positive' : value >= .55 ? 'warning' : 'danger'; }

export function healthHeadline(health: PlanHealth): string {
  if (health.overall >= .85) return 'A considered, shareable plan';
  if (health.overall >= .65) return 'A promising plan in review';
  return 'A plan that needs another pass';
}

export function keyObjectTitles(artifacts: Artifact[]): string[] { return artifacts.filter((artifact) => artifact.isKeyObject).map((artifact) => artifact.title); }

export function issueLoad(issues: ReviewIssue[]): number { return issues.reduce((sum, issue) => sum + (issue.severity === 'critical' ? 3 : issue.severity === 'warning' ? 2 : 1), 0); }
