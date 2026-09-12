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
  /** Recoverable placement removal transactions, newest first. */
  removals: PlacementRemoval[];
  /** Frozen export records; recovery never mutates or deletes these. */
  publications: SnapshotPublication[];
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

export type PlacementRemovalStatus = 'held' | 'restored' | 'in-review';
export type RestoreConflictReason =
  | 'not-held'
  | 'object-missing'
  | 'zone-missing'
  | 'object-modified'
  | 'already-placed'
  | 'position-ambiguous'
  | 'constraint-violation'
  | 'export-dependency-stale';

export interface RelatedFindingRef {
  issueId: string;
  title: string;
  severity: IssueSeverity;
  status: IssueStatus;
}

export interface ExportDependencyRef {
  snapshotGeneratedAt: string;
  readinessScore: number;
  includesObject: boolean;
}

/**
 * A recoverable record of removing an artifact placement from the journey.
 * The record captures enough context (source zone, index, neighboring objects,
 * linked findings, export dependencies, version stamps) to restore the
 * placement deterministically or route the case to manual review.
 */
export interface PlacementRemoval {
  id: string;
  artifactId: string;
  artifactVersion: string;
  zoneId: string;
  zoneVersion: string;
  index: number;
  neighborBeforeId: string | null;
  neighborAfterId: string | null;
  zoneOrderAfterRemoval: string[];
  relatedFindings: RelatedFindingRef[];
  exportDependencies: ExportDependencyRef[];
  status: PlacementRemovalStatus;
  createdAt: string;
  restoredAt?: string;
  conflictReason?: RestoreConflictReason;
  conflictDetail?: string;
  reviewAttempts: number;
}

/** A frozen release artifact produced from the workspace; never rewritten by recovery. */
export interface SnapshotPublication {
  generatedAt: string;
  fileName: string;
  readinessScore: number;
  zoneIds: string[];
  artifactIds: string[];
}

export interface RemovalPlan {
  artifactId: string;
  artifactTitle: string;
  zoneId: string;
  zoneName: string;
  index: number;
  neighborBeforeTitle: string | null;
  neighborAfterTitle: string | null;
  relatedFindings: RelatedFindingRef[];
  exportDependencies: ExportDependencyRef[];
}
