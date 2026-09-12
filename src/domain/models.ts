export type ProjectStage = 'draft' | 'review' | 'ready';
export type NarrativeRole = 'threshold' | 'context' | 'turning-point' | 'reflection';
export type Sensitivity = 'standard' | 'low-light' | 'fragile';
export type RotationClass = Exclude<Sensitivity, 'standard'>;
export type IssueSeverity = 'note' | 'warning' | 'critical';
export type IssueStatus = 'open' | 'in-progress' | 'resolved';
export type AccessibilityNeed = 'none' | 'seating' | 'audio' | 'tactile-alternative';
export type RotationPlanStatus = 'draft' | 'confirmed' | 'review';
export type RotationBatchState = 'ok' | 'stale' | 'missing';

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

export interface RotationStint {
  kind: 'display' | 'rest';
  startDate: string;
  endDate: string;
  zoneId?: string;
  zoneName?: string;
  loadMinutes: number;
}

export interface RotationDependency {
  artifactId: string;
  artifactTitle: string;
  sensitivity: Sensitivity;
  artifactVersion: string;
  zoneId?: string;
  zoneName?: string;
  zoneVersion?: string;
}

export interface RotationBatch {
  id: string;
  label: string;
  rotationClass: RotationClass;
  displayDays: number;
  restDays: number;
  artifactIds: string[];
  stints: RotationStint[];
  dependencies: RotationDependency[];
  manual: boolean;
  updatedAt: string;
}

export interface RotationPlan {
  id: string;
  name: string;
  status: RotationPlanStatus;
  openingDate: string;
  horizonDays: number;
  batchIds: string[];
  batches: RotationBatch[];
  warnings: string[];
  reviewReasons: string[];
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
}

export interface RotationBatchHealth {
  batchId: string;
  label: string;
  state: RotationBatchState;
  reasons: string[];
}

export interface RotationPlanHealth {
  planId: string;
  status: RotationPlanStatus;
  openingDateMismatch: boolean;
  batches: RotationBatchHealth[];
  reasons: string[];
  warnings: string[];
  uncoveredSensitive: string[];
  canConfirm: boolean;
  staleBatchIds: string[];
  missingBatchIds: string[];
}

export interface RotationPlanExport {
  schemaVersion: 1;
  generatedAt: string;
  planId: string;
  planName: string;
  planStatus: RotationPlanStatus;
  openingDate: string;
  horizonDays: number;
  reviewReasons: string[];
  warnings: string[];
  batches: Array<{
    batchId: string;
    label: string;
    rotationClass: RotationClass;
    displayDays: number;
    restDays: number;
    manual: boolean;
    state: RotationBatchState;
    stateReasons: string[];
    dependencies: RotationDependency[];
    stints: RotationStint[];
  }>;
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
  rotationPlans: RotationPlan[];
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
  rotationPlans: RotationPlan[];
}
