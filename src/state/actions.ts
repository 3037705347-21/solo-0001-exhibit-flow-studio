import type {
  Artifact,
  IssueStatus,
  PlanningPreferences,
  ReadinessRun,
  ReviewIssue,
  RuleBinding,
  RuleProfile,
  WorkspaceState,
} from '../domain/models';

export type WorkspaceAction =
  | { type: 'artifact/upsert'; artifact: Artifact }
  | { type: 'artifact/remove'; artifactId: string }
  | { type: 'placement/assign'; artifactId: string; zoneId: string; index?: number }
  | { type: 'placement/remove'; artifactId: string }
  | { type: 'placement/reorder'; zoneId: string; artifactId: string; direction: -1 | 1 }
  | { type: 'issue/add'; issue: ReviewIssue }
  | { type: 'issue/transition'; issueId: string; status: IssueStatus; at?: Date }
  | { type: 'preferences/update'; preferences: PlanningPreferences }
  | { type: 'project/readiness'; ready: boolean; checkedAt: string; run: ReadinessRun }
  /** Append an immutable new archive version; does not rebind the project. */
  | { type: 'rules/publish'; profile: RuleProfile }
  /** Explicitly switch the project's binding to an existing archive version. */
  | { type: 'rules/bind'; binding: RuleBinding }
  | { type: 'rules/repair'; binding: RuleBinding }
  | { type: 'workspace/reset'; state: WorkspaceState };
