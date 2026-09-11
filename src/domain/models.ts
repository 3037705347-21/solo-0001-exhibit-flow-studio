export type ProjectStage = 'draft' | 'review' | 'ready';
export type NarrativeRole = 'threshold' | 'context' | 'turning-point' | 'reflection';
export type Sensitivity = 'standard' | 'low-light' | 'fragile';
export type IssueSeverity = 'note' | 'warning' | 'critical';
export type IssueStatus = 'open' | 'in-progress' | 'resolved';
export type AccessibilityNeed = 'none' | 'seating' | 'audio' | 'tactile-alternative';

export interface Dimensions {
  width: number;
  height: number;
  depth: number;
  unit: 'cm';
}

export interface Artifact {
  id: string;
  accessionId: string;
  title: string;
  maker: string;
  yearLabel: string;
  medium: string;
  origin: string;
  summary: string;
  dimensions: Dimensions;
  dwellMinutes: number;
  narrativeRole: NarrativeRole;
  sensitivity: Sensitivity;
  accessibilityNeed: AccessibilityNeed;
  isKeyObject: boolean;
  tags: string[];
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface Zone {
  id: string;
  name: string;
  shortLabel: string;
  thesis: string;
  capacityMinutes: number;
  maxObjects: number;
  lowLight: boolean;
  hasSeating: boolean;
  color: string;
  sequence: number;
  artifactIds: string[];
}

export interface ReviewIssue {
  id: string;
  title: string;
  description: string;
  severity: IssueSeverity;
  status: IssueStatus;
  zoneId?: string;
  artifactId?: string;
  owner: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface PlanningPreferences {
  pace: 'focused' | 'balanced' | 'leisurely';
  accessibilityPriority: number;
  groupSize: number;
}

export interface ExhibitProject {
  id: string;
  title: string;
  venue: string;
  audience: string;
  openingDate: string;
  stage: ProjectStage;
  lastReadinessCheck?: string;
}

export interface WorkspaceState {
  version: 1;
  project: ExhibitProject;
  artifacts: Artifact[];
  zones: Zone[];
  issues: ReviewIssue[];
  preferences: PlanningPreferences;
  /** Append-only ledger of exported packages; never rewritten by deletes. */
  publishedPackages: PublishedPackage[];
  /** Recoverable deletion audit trail (records prune after the audit horizon). */
  deletionRecords: DeletionRecord[];
  restoreReports: RestoreReport[];
  lastSavedAt?: string;
}

export interface ArtifactDraft {
  accessionId: string;
  title: string;
  maker: string;
  yearLabel: string;
  medium: string;
  origin: string;
  summary: string;
  width: string;
  height: string;
  depth: string;
  dwellMinutes: string;
  narrativeRole: NarrativeRole;
  sensitivity: Sensitivity;
  accessibilityNeed: AccessibilityNeed;
  isKeyObject: boolean;
  tags: string;
  color: string;
}

export interface IssueDraft {
  title: string;
  description: string;
  severity: IssueSeverity;
  owner: string;
  zoneId: string;
  artifactId: string;
}

export interface ValidationError {
  field: string;
  message: string;
}

export interface ConstraintFinding {
  id: string;
  type: 'error' | 'warning' | 'notice';
  title: string;
  detail: string;
  zoneId?: string;
  artifactId?: string;
}

export interface ZoneAnalysis {
  zoneId: string;
  dwellMinutes: number;
  utilization: number;
  objectCount: number;
  objectUtilization: number;
  roleCoverage: NarrativeRole[];
  findings: ConstraintFinding[];
}

export interface JourneyAnalysis {
  totalDwellMinutes: number;
  placedCount: number;
  unplacedCount: number;
  keyObjectCoverage: number;
  roleCoverage: number;
  zones: ZoneAnalysis[];
  findings: ConstraintFinding[];
  blockingCount: number;
  warningCount: number;
}

export interface ReadinessResult {
  ready: boolean;
  score: number;
  blockers: string[];
  cautions: string[];
  checkedAt: string;
}

export interface ScenarioInput {
  pace: PlanningPreferences['pace'];
  accessibilityPriority: number;
  groupSize: number;
}

export interface ScenarioProjection {
  durationMinutes: number;
  comfortScore: number;
  accessibilityScore: number;
  narrativeScore: number;
  pressureZoneIds: string[];
  recommendations: string[];
}

export interface Snapshot {
  schemaVersion: 1;
  generatedAt: string;
  project: ExhibitProject;
  summary: {
    artifactCount: number;
    zoneCount: number;
    visitMinutes: number;
    readinessScore: number;
  };
  zones: Array<Zone & { artifacts: Artifact[] }>;
  unresolvedIssues: ReviewIssue[];
}

/**
 * A published export package recorded in an append-only ledger. The ledger is
 * never rewritten by later deletes, so the historical package keeps describing
 * the plan exactly as it was when it left the studio.
 */
export interface PublishedPackage {
  id: string;
  kind: 'snapshot' | 'zone-checklist';
  fileName: string;
  publishedAt: string;
  projectTitle: string;
  zoneId?: string;
  /** Areas fully contained in a plan-wide snapshot. */
  zoneIds?: string[];
  artifactIds: string[];
  issueIds: string[];
}

export type DeletionTargetKind = 'artifact' | 'zone' | 'issue';

/**
 * An auditable, recoverable record of a delete. The full pre-delete state of
 * every reference touched by the delete is captured here so the impact review
 * can preview the change and a later restore can re-create the exact graph
 * without mutating historical published packages.
 */
export interface DeletionRecord {
  id: string;
  kind: DeletionTargetKind;
  deletedAt: string;
  expiresAt: string;
  targetId: string;
  targetLabel: string;
  /** Primary record removed by the user (artifact or zone); absent for findings. */
  artifact?: Artifact;
  zone?: Zone;
  issue?: ReviewIssue;
  /** Placements removed or detached, in their original zone/position order. */
  placements: Array<{ zoneId: string; zoneName: string; index: number; artifactId: string; artifactTitle: string; action: 'removed' | 'detached' }>;
  /** Findings cascade-removed (artifact delete) or detached (zone delete). */
  cascadeIssues: ReviewIssue[];
  detachments: Array<{ issueId: string; issueTitle: string; field: 'zoneId' | 'artifactId' }>;
  /** Published packages that referenced the deleted graph at delete time. */
  publishedPackageIds: string[];
  restoredAt?: string;
  purgedAt?: string;
}

export type RestoreDecision = 'restore' | 'overwrite' | 'skip' | 'detach';

export interface RestoreConflict {
  id: string;
  severity: 'blocking' | 'warning';
  subject: 'record' | 'placement' | 'issue' | 'zone';
  subjectLabel: string;
  message: string;
  options: RestoreDecision[];
  decision: RestoreDecision;
}

export interface RestoreSummaryLine {
  label: string;
  outcome: 'restored' | 'overwritten' | 'skipped' | 'detached';
}

export interface RestoreReport {
  recordId: string;
  restoredAt: string;
  lines: RestoreSummaryLine[];
}
