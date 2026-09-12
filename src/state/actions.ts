import type { Artifact, IssueStatus, PlanningPreferences, ReviewIssue, WorkspaceState } from '../domain/models';

export type WorkspaceAction =
  | { type: 'artifact/upsert'; artifact: Artifact }
  | { type: 'artifact/remove'; artifactId: string }
  | { type: 'placement/assign'; artifactId: string; zoneId: string; index?: number }
  | { type: 'placement/remove'; artifactId: string }
  | {
      type: 'placement/reorder';
      zoneId: string;
      artifactId: string;
      /** Zone version the resolved `nextOrder` was computed from (compare-and-swap guard). */
      expectedVersion: number;
      /** Resolved order; must be an exact permutation of the zone's current order. */
      nextOrder: string[];
    }
  | { type: 'issue/add'; issue: ReviewIssue }
  | { type: 'issue/transition'; issueId: string; status: IssueStatus; at?: Date }
  | { type: 'preferences/update'; preferences: PlanningPreferences }
  | { type: 'project/readiness'; ready: boolean; checkedAt: string }
  | { type: 'workspace/restore'; state: WorkspaceState }
  | { type: 'workspace/external'; state: WorkspaceState }
  | { type: 'workspace/reset'; state: WorkspaceState };
