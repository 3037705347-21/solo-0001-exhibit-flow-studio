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
  /** Optimistic-concurrency version, bumped by every status transition. */
  revision: number;
  /** Audit trail: id of the batch transaction that last changed this finding. */
  lastBatchId?: string;
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
  lastSavedAt?: string;
  /** Idempotency registry: committed batch transition reports keyed by batch id. */
  processedBatches?: Record<string, BatchTransitionReport>;
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

/**
 * One versioned transition request inside a batch transaction.
 * `baseRevision` is the issue revision the caller observed when deciding;
 * the commit re-checks it against the current record before writing.
 */
export interface BatchTransitionIntent {
  issueId: string;
  target: IssueStatus;
  baseRevision: number;
}

export type BatchItemResult =
  | { issueId: string; outcome: 'applied'; from: IssueStatus; to: IssueStatus; revision: number }
  | { issueId: string; outcome: 'skipped'; reason: 'already-in-target'; status: IssueStatus }
  | { issueId: string; outcome: 'conflict'; reason: 'externally-modified'; expectedRevision: number; currentRevision: number; currentStatus: IssueStatus }
  | { issueId: string; outcome: 'invalid'; reason: 'not-found' }
  | { issueId: string; outcome: 'invalid'; reason: 'illegal-transition'; from: IssueStatus; to: IssueStatus }
  | { issueId: string; outcome: 'invalid'; reason: 'duplicate-in-batch' };

export interface BatchOutcomeCounts {
  applied: number;
  skipped: number;
  conflict: number;
  invalid: number;
}

export interface BatchTransitionReport {
  batchId: string;
  at: string;
  results: BatchItemResult[];
  counts: BatchOutcomeCounts;
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
