import type { Artifact, IssueStatus, PlanningPreferences, PlacementRemoval, ReviewIssue, SnapshotPublication, WorkspaceState } from '../domain/models';

export type WorkspaceAction =
  | { type: 'artifact/upsert'; artifact: Artifact }
  | { type: 'artifact/remove'; artifactId: string }
  | { type: 'placement/assign'; artifactId: string; zoneId: string; index?: number }
  | { type: 'placement/remove'; removal: PlacementRemoval }
  | { type: 'placement/restore'; removalId: string; approved?: boolean; at?: string }
  | { type: 'placement/removal-discard'; removalId: string }
  | { type: 'placement/reorder'; zoneId: string; artifactId: string; direction: -1 | 1 }
  | { type: 'issue/add'; issue: ReviewIssue }
  | { type: 'issue/transition'; issueId: string; status: IssueStatus; at?: Date }
  | { type: 'preferences/update'; preferences: PlanningPreferences }
  | { type: 'project/readiness'; ready: boolean; checkedAt: string }
  | { type: 'snapshot/published'; publication: SnapshotPublication }
  | { type: 'workspace/reset'; state: WorkspaceState };
