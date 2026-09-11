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

export type LineageNodeType = 'artifact' | 'placement' | 'issue' | 'snapshot' | 'batch';
export type LineageOrigin = 'direct' | 'import' | 'seed' | 'backfill';
export type StaleReason = 'source-modified' | 'source-deleted' | 'source-removed' | 'upstream-stale';

export interface LineageNode {
  id: string;
  type: LineageNodeType;
  label: string;
  origin: LineageOrigin;
  batchId?: string;
  batchFileName?: string;
  createdAt: string;
  updatedAt: string;
  /** Stable content fingerprint so repeat imports/identical edits do not flag stale. */
  signature?: string;
  staleReason?: StaleReason;
  staleSince?: string;
  tombstoned: boolean;
  tombstonedAt?: string;
  /** Context captured for deleted sources, e.g. the zone a placement lived in. */
  contextLabel?: string;
}

export type LineageEdgeReason =
  | 'assigned'
  | 'linked'
  | 'included-in'
  | 'exported'
  | 'generated'
  | 'depends-on';

export interface LineageEdge {
  id: string;
  upstream: string;
  downstream: string;
  reason: LineageEdgeReason;
  createdAt: string;
}

export interface ImportBatch {
  id: string;
  fileName: string;
  contentHash: string;
  importedAt: string;
  artifactIds: string[];
}

export interface LineageState {
  nodes: LineageNode[];
  edges: LineageEdge[];
  batches: ImportBatch[];
}

export interface WorkspaceState {
  version: 1;
  project: ExhibitProject;
  artifacts: Artifact[];
  zones: Zone[];
  issues: ReviewIssue[];
  preferences: PlanningPreferences;
  lineage: LineageState;
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

export interface SnapshotDependency {
  nodeId: string;
  type: LineageNodeType;
  label: string;
  origin: LineageOrigin;
  status: 'valid' | 'needs-review';
  staleReason?: StaleReason;
  batchFileName?: string;
  dependsOn: string[];
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
  lineage: {
    snapshotNodeId: string;
    dependencyCount: number;
    needsReviewCount: number;
    importedCount: number;
    dependencies: SnapshotDependency[];
  };
}
