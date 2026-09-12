import type {
  Artifact,
  IssueStatus,
  PlanningPreferences,
  ReviewIssue,
  RotationPlan,
  WorkspaceState,
  Zone,
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
  | { type: 'project/readiness'; ready: boolean; checkedAt: string }
  | { type: 'project/openingDate'; openingDate: string }
  | { type: 'zone/update'; zone: Zone }
  | { type: 'rotation/generate'; plan: RotationPlan }
  | { type: 'rotation/replace'; plans: RotationPlan[] }
  | { type: 'rotation/remove'; planId: string }
  | { type: 'workspace/reset'; state: WorkspaceState };
