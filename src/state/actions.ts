import type { Artifact, IssueStatus, PlanningPreferences, ReviewIssue, WorkspaceState } from '../domain/models';

export type WorkspaceAction =
  | { type: 'artifact/upsert'; artifact: Artifact }
  | { type: 'artifact/remove'; artifactId: string }
  | { type: 'placement/assign'; artifactId: string; zoneId: string; index?: number }
  | { type: 'placement/remove'; artifactId: string }
  | { type: 'placement/reorder'; zoneId: string; artifactId: string; direction: -1 | 1 }
  | { type: 'issue/add'; issue: ReviewIssue }
  | { type: 'issue/remediation-batch'; issues: ReviewIssue[] }
  | { type: 'issue/transition'; issueId: string; status: IssueStatus; at?: Date }
  | { type: 'preferences/update'; preferences: PlanningPreferences }
  | { type: 'project/readiness'; ready: boolean; checkedAt: string }
  | { type: 'workspace/reset'; state: WorkspaceState };
