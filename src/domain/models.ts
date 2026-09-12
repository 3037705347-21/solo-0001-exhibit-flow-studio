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

export interface CollectionFilter {
  query: string;
  roles: string[];
  sensitivities: string[];
  keyOnly: boolean;
}

/**
 * One immutable revision of a saved view's rule set. Every revision records the
 * rule version number, the membership it produced (member identity), and the
 * basis from which the rules were created ("创建依据").
 */
export interface CollectionRuleVersion {
  version: number;
  rules: CollectionFilter;
  memberIds: string[];
  basis: string;
  createdAt: string;
}

/** Fields captured per member when a frozen list is issued; used to detect drift. */
export interface FrozenMemberSnapshot {
  artifactId: string;
  accessionId: string;
  title: string;
  narrativeRole: NarrativeRole;
  sensitivity: Sensitivity;
  isKeyObject: boolean;
}

/**
 * A saved collection view.
 * - `live` views follow the collection: membership is always recomputed from
 *   the current object set against the latest rule version.
 * - `frozen` lists are issued material: membership never re-runs; the member
 *   snapshots stay fixed and each member is flagged when the live object drifts.
 */
export interface CollectionView {
  id: string;
  name: string;
  kind: 'live' | 'frozen';
  createdAt: string;
  updatedAt: string;
  ruleVersions: CollectionRuleVersion[];
  frozenMembers?: FrozenMemberSnapshot[];
}

export type FrozenMemberState =
  | 'intact'
  | 'changed'
  | 'missing';

export interface FrozenMemberEntry {
  snapshot: FrozenMemberSnapshot;
  current?: Artifact;
  state: FrozenMemberState;
  changedFields: Array<keyof FrozenMemberSnapshot>;
}

export interface FrozenViewEvaluation {
  entries: FrozenMemberEntry[];
  intactCount: number;
  changedCount: number;
  missingCount: number;
  /** True when any issued member has drifted; the frozen list must not be treated as current evidence. */
  isStale: boolean;
  /** Objects now matching the rules that were not part of the issued list. Informational only. */
  addedArtifacts: Artifact[];
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
  collectionViews: CollectionView[];
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
