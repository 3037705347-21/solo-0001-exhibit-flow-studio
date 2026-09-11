import type {
  Artifact,
  DeletionRecord,
  IssueStatus,
  PlanningPreferences,
  PublishedPackage,
  RestoreDecision,
  ReviewIssue,
  WorkspaceState,
} from '../domain/models';

export type WorkspaceAction =
  | { type: 'artifact/upsert'; artifact: Artifact }
  | { type: 'artifact/delete'; record: DeletionRecord }
  | { type: 'zone/delete'; record: DeletionRecord }
  | { type: 'issue/add'; issue: ReviewIssue }
  | { type: 'issue/delete'; record: DeletionRecord }
  | { type: 'deletion/restore'; recordId: string; decisions: Record<string, RestoreDecision>; at: string }
  | { type: 'placement/assign'; artifactId: string; zoneId: string; index?: number }
  | { type: 'placement/remove'; artifactId: string }
  | { type: 'placement/reorder'; zoneId: string; artifactId: string; direction: -1 | 1 }
  | { type: 'issue/transition'; issueId: string; status: IssueStatus; at?: Date }
  | { type: 'preferences/update'; preferences: PlanningPreferences }
  | { type: 'package/publish'; pkg: PublishedPackage }
  | { type: 'project/readiness'; ready: boolean; checkedAt: string }
  | { type: 'workspace/reset'; state: WorkspaceState };
