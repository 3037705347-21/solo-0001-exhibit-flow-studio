import { daysUntil } from './dateMath';
import { formatPercent, titleCase } from './formatters';
import { analyzeJourney } from './journeyAnalysis';
import type {
  Artifact,
  JourneyAnalysis,
  NarrativeRole,
  ProjectStage,
  ReadinessResult,
  ReviewIssue,
  WorkspaceState,
} from './models';
import { evaluateReadiness, issueProgress } from './reviewRules';
import { projectScenario } from './scenario';

export type CommandRiskLevel = 'critical' | 'warning' | 'info';
export type CommandRiskArea = 'collection' | 'journey' | 'review' | 'insights';

export interface CommandRisk {
  id: string;
  level: CommandRiskLevel;
  area: CommandRiskArea;
  title: string;
  detail: string;
  /** Internal route (with optional query string) that locates the source of the risk. */
  to: string;
  cta: string;
}

export interface CapacityRiskView {
  zoneId: string;
  zoneName: string;
  color: string;
  dwellMinutes: number;
  capacityMinutes: number;
  objectCount: number;
  maxObjects: number;
  dwellUtilization: number;
  objectUtilization: number;
  level: CommandRiskLevel;
  /** Flagged by the saved scenario projection (insights engine) as a pressure zone. */
  pressured: boolean;
  detail: string;
  to: string;
}

export interface CoverageView {
  keyPlaced: number;
  keyTotal: number;
  keyRatio: number;
  rolesCovered: NarrativeRole[];
  missingRoles: NarrativeRole[];
  roleRatio: number;
  placedCount: number;
  totalArtifacts: number;
  placementRatio: number;
}

export type LastCheckStatus = 'none' | 'passed' | 'needs-refresh' | 'blocked';

export interface LastCheckView {
  hasCheck: boolean;
  checkedAt?: string;
  status: LastCheckStatus;
  /** The recorded check still confirms the plan as ready. */
  passed: boolean;
}

export interface CommandCenter {
  empty: boolean;
  project: WorkspaceState['project'];
  stage: ProjectStage;
  openingDate: string;
  daysToOpening: number | null;
  countdownLabel: string;
  analysis: JourneyAnalysis;
  readiness: ReadinessResult;
  coverage: CoverageView;
  unresolvedIssues: ReviewIssue[];
  criticalIssues: ReviewIssue[];
  issueProgress: number;
  capacityRisks: CapacityRiskView[];
  pressureZoneIds: string[];
  risks: CommandRisk[];
  lastCheck: LastCheckView;
}

const ALL_ROLES: NarrativeRole[] = ['threshold', 'context', 'turning-point', 'reflection'];
const LEVEL_RANK: Record<CommandRiskLevel, number> = { critical: 0, warning: 1, info: 2 };
const AREA_RANK: Record<CommandRiskArea, number> = { review: 0, journey: 1, collection: 2, insights: 3 };

function isWorkspaceEmpty(state: WorkspaceState): boolean {
  return state.artifacts.length === 0 && state.zones.length === 0 && state.issues.length === 0;
}

function countdownLabel(openingDate: string): { days: number | null; label: string } {
  if (!openingDate) return { days: null, label: 'Opening date not set' };
  const days = daysUntil(openingDate);
  if (days < 0) return { days, label: `Opened ${Math.abs(days)} day${days === -1 ? '' : 's'} ago` };
  if (days === 0) return { days, label: 'Opening day' };
  return { days, label: `${days} day${days === 1 ? '' : 's'} to opening` };
}

export function buildCoverage(state: WorkspaceState, analysis: JourneyAnalysis): CoverageView {
  const keyObjects = state.artifacts.filter((artifact) => artifact.isKeyObject);
  const placedIds = new Set(state.zones.flatMap((zone) => zone.artifactIds));
  const keyPlaced = keyObjects.filter((artifact) => placedIds.has(artifact.id)).length;
  const rolesCovered = ALL_ROLES.filter((role) =>
    state.artifacts.some((artifact) => placedIds.has(artifact.id) && artifact.narrativeRole === role),
  );
  const missingRoles = ALL_ROLES.filter((role) => !rolesCovered.includes(role));
  return {
    keyPlaced,
    keyTotal: keyObjects.length,
    keyRatio: analysis.keyObjectCoverage,
    rolesCovered,
    missingRoles,
    roleRatio: analysis.roleCoverage,
    placedCount: analysis.placedCount,
    totalArtifacts: state.artifacts.length,
    placementRatio: state.artifacts.length ? analysis.placedCount / state.artifacts.length : 1,
  };
}

export function buildCapacityRisks(state: WorkspaceState, analysis: JourneyAnalysis, pressureZoneIds: string[] = []): CapacityRiskView[] {
  const byId = new Map(analysis.zones.map((zone) => [zone.zoneId, zone]));
  const pressured = new Set(pressureZoneIds);
  return state.zones
    .slice()
    .sort((left, right) => left.sequence - right.sequence)
    .map((zone) => {
      const zoneAnalysis = byId.get(zone.id);
      const dwellUtilization = zoneAnalysis?.utilization ?? 0;
      const objectUtilization = zoneAnalysis?.objectUtilization ?? 0;
      const level: CommandRiskLevel = dwellUtilization > 1 || objectUtilization > 1
        ? 'critical'
        : dwellUtilization >= 0.8 || objectUtilization >= 0.8 || pressured.has(zone.id) ? 'warning' : 'info';
      const detail = `${zoneAnalysis?.dwellMinutes ?? 0}/${zone.capacityMinutes} min · ${zoneAnalysis?.objectCount ?? 0}/${zone.maxObjects} objects`;
      return {
        zoneId: zone.id,
        zoneName: zone.name,
        color: zone.color,
        dwellMinutes: zoneAnalysis?.dwellMinutes ?? 0,
        capacityMinutes: zone.capacityMinutes,
        objectCount: zoneAnalysis?.objectCount ?? 0,
        maxObjects: zone.maxObjects,
        dwellUtilization,
        objectUtilization,
        level,
        pressured: pressured.has(zone.id),
        detail,
        to: pressured.has(zone.id) ? `/insights?zone=${zone.id}` : `/journey?zone=${zone.id}`,
      };
    })
    .filter((zone) => zone.level !== 'info');
}

function issueRisks(issues: ReviewIssue[], artifactsById: Map<string, Artifact>): CommandRisk[] {
  return issues
    .filter((issue) => issue.status !== 'resolved')
    .map((issue) => {
      const linked = issue.artifactId ? artifactsById.get(issue.artifactId)?.title : undefined;
      const level: CommandRiskLevel = issue.severity === 'critical'
        ? 'critical'
        : issue.severity === 'warning' ? 'warning' : 'info';
      return {
        id: `risk-issue-${issue.id}`,
        level,
        area: 'review' as const,
        title: issue.title,
        detail: `${titleCase(issue.severity)} finding · ${issue.owner}${linked ? ` · ${linked}` : ''}`,
        to: `/review?issue=${issue.id}`,
        cta: 'Open in review desk',
      };
    });
}

function journeyRisks(state: WorkspaceState, analysis: JourneyAnalysis, coverage: CoverageView): CommandRisk[] {
  const risks: CommandRisk[] = [];
  const zoneById = new Map(state.zones.map((zone) => [zone.id, zone]));
  const artifactsById = new Map(state.artifacts.map((artifact) => [artifact.id, artifact]));
  const placedIds = new Set(state.zones.flatMap((zone) => zone.artifactIds));

  if (state.artifacts.length === 0) {
    risks.push({
      id: 'risk-empty-collection',
      level: 'critical',
      area: 'collection',
      title: 'The collection is empty',
      detail: 'Add objects before the team can plan a visitor journey.',
      to: '/collection',
      cta: 'Add the first object',
    });
  } else if (coverage.placementRatio < 1) {
    const level: CommandRiskLevel = coverage.placedCount === 0 ? 'critical' : 'warning';
    const loneUnplaced = analysis.unplacedCount === 1
      ? state.artifacts.find((artifact) => !placedIds.has(artifact.id))
      : undefined;
    risks.push({
      id: 'risk-unplaced',
      level,
      area: 'journey',
      title: `${analysis.unplacedCount} object${analysis.unplacedCount === 1 ? '' : 's'} not placed in the journey`,
      detail: `${coverage.placedCount} of ${coverage.totalArtifacts} collection objects (${formatPercent(coverage.placementRatio)}) have a zone.`,
      to: loneUnplaced ? `/journey?artifact=${loneUnplaced.id}` : '/journey',
      cta: loneUnplaced ? `Place ${loneUnplaced.title}` : 'Open visitor journey',
    });
  }

  const unplacedKeyIds = new Set(
    analysis.findings.filter((finding) => finding.id.startsWith('unplaced-key-')).map((finding) => finding.artifactId),
  );
  for (const artifactId of unplacedKeyIds) {
    if (!artifactId) continue;
    const artifact = artifactsById.get(artifactId);
    if (!artifact) continue;
    risks.push({
      id: `risk-key-${artifactId}`,
      level: 'critical',
      area: 'journey',
      title: `Key object not placed: ${artifact.title}`,
      detail: 'Every key object must be placed before readiness can pass.',
      to: `/journey?artifact=${artifactId}`,
      cta: 'Place in journey',
    });
  }

  for (const role of coverage.missingRoles) {
    // With nothing collected or placed, the empty-collection risk already says this.
    if (state.artifacts.length === 0) continue;
    risks.push({
      id: `risk-role-${role}`,
      level: role === 'turning-point' ? 'critical' : 'warning',
      area: 'journey',
      title: `Missing ${titleCase(role)} role in the journey`,
      detail: 'The placed objects do not yet carry this part of the story arc.',
      to: '/journey',
      cta: 'Review story coverage',
    });
  }

  for (const finding of analysis.findings) {
    if (finding.id.startsWith('unplaced-key-') || finding.id.startsWith('missing-role-')) continue;
    if (finding.type === 'notice') continue;
    const zone = finding.zoneId ? zoneById.get(finding.zoneId) : undefined;
    risks.push({
      id: `risk-${finding.id}`,
      level: finding.type === 'error' ? 'critical' : 'warning',
      area: 'journey',
      title: finding.title,
      detail: finding.detail,
      to: `/journey${zone ? `?zone=${zone.id}` : ''}`,
      cta: zone ? `Open ${zone.shortLabel}` : 'Open visitor journey',
    });
  }

  return risks;
}

function checkRisks(lastCheck: LastCheckView, readiness: ReadinessResult): CommandRisk[] {
  const risks: CommandRisk[] = [];
  if (lastCheck.status === 'none') {
    risks.push({
      id: 'risk-no-check',
      level: 'info',
      area: 'review',
      title: 'No formal readiness check recorded',
      detail: 'Run a readiness check from the review desk to record the project gate.',
      to: '/review',
      cta: 'Run readiness check',
    });
  } else if (lastCheck.status === 'blocked') {
    risks.push({
      id: 'risk-last-check-blocked',
      level: 'warning',
      area: 'review',
      title: 'The last formal readiness check did not pass',
      detail: `Re-run the gate after addressing the remaining conditions.`,
      to: '/review',
      cta: 'Open review desk',
    });
  } else if (lastCheck.status === 'needs-refresh') {
    risks.push({
      id: 'risk-check-needs-refresh',
      level: readiness.ready ? 'info' : 'warning',
      area: 'review',
      title: 'The passing readiness check is no longer current',
      detail: readiness.ready
        ? 'Plan content changed after the check; the plan still clears the gate, but the formal record should be refreshed.'
        : 'Plan content changed after the check and blocking conditions have returned; re-run the gate.',
      to: '/review',
      cta: 'Re-run readiness check',
    });
  }
  return risks;
}

export function rankRisks(risks: CommandRisk[]): CommandRisk[] {
  return [...risks].sort((left, right) => {
    const level = LEVEL_RANK[left.level] - LEVEL_RANK[right.level];
    if (level !== 0) return level;
    const area = AREA_RANK[left.area] - AREA_RANK[right.area];
    if (area !== 0) return area;
    return left.title.localeCompare(right.title);
  });
}

/**
 * Single project-level read model. Every number is taken from the existing
 * domain engines so the command center can never drift from the feature pages.
 */
export function buildCommandCenter(state: WorkspaceState, at: Date = new Date()) {
  const empty = isWorkspaceEmpty(state);
  const analysis = analyzeJourney(state.artifacts, state.zones);
  const readiness = evaluateReadiness(state, analysis, at);
  const coverage = buildCoverage(state, analysis);
  const projection = projectScenario(state, analysis, state.preferences);
  const capacityRisks = buildCapacityRisks(state, analysis, projection.pressureZoneIds);
  const unresolvedIssues = state.issues.filter((issue) => issue.status !== 'resolved');
  const criticalIssues = unresolvedIssues.filter((issue) => issue.severity === 'critical');
  const artifactsById = new Map(state.artifacts.map((artifact) => [artifact.id, artifact]));

  const { days, label } = countdownLabel(state.project.openingDate);
  // The persisted stage is the recorded gate result: a later content change
  // regresses `ready` back to `review`, so a passed check is only "current"
  // while the stage remains `ready` and the live engine still clears.
  const lastCheck: LastCheckView = {
    hasCheck: Boolean(state.project.lastReadinessCheck),
    checkedAt: state.project.lastReadinessCheck,
    passed: state.project.stage === 'ready',
    status: !state.project.lastReadinessCheck
      ? 'none'
      : state.project.stage === 'ready'
        ? 'passed'
        : readiness.ready
          ? 'needs-refresh'
          : 'blocked',
  };

  const risks = rankRisks([
    ...issueRisks(unresolvedIssues, artifactsById),
    ...journeyRisks(state, analysis, coverage),
    ...checkRisks(lastCheck, readiness),
  ]);

  const commandCenter: CommandCenter = {
    empty,
    project: state.project,
    stage: state.project.stage,
    openingDate: state.project.openingDate,
    daysToOpening: days,
    countdownLabel: label,
    analysis,
    readiness,
    coverage,
    unresolvedIssues,
    criticalIssues,
    issueProgress: issueProgress(state.issues),
    capacityRisks,
    pressureZoneIds: projection.pressureZoneIds,
    risks,
    lastCheck,
  };
  return commandCenter;
}
