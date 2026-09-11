import type { Artifact, IssueSeverity, PlanningPreferences, ReviewIssue, WorkspaceState } from '../domain/models';

export type WorkspaceAction =
  | { type: 'artifact/upsert'; artifact: Artifact }
  | { type: 'artifact/remove'; artifactId: string }
  | { type: 'placement/assign'; artifactId: string; zoneId: string; index?: number }
  | { type: 'placement/remove'; artifactId: string }
  | { type: 'placement/reorder'; zoneId: string; artifactId: string; direction: -1 | 1 }
  | { type: 'issue/add'; issue: ReviewIssue }
  | { type: 'issue/transition'; issueId: string; status: ReviewIssue['status']; at?: Date; actor?: string; note?: string }
  | {
      type: 'issue/edit';
      issueId: string;
      patch: { title?: string; description?: string; severity?: IssueSeverity; zoneId?: string; artifactId?: string };
      at?: Date;
      actor?: string;
      note?: string;
    }
  | { type: 'issue/reassign'; issueId: string; owner: string; at?: Date; actor?: string; note?: string }
  | { type: 'preferences/update'; preferences: PlanningPreferences }
  | { type: 'project/readiness'; ready: boolean; checkedAt: string }
  | { type: 'workspace/reset'; state: WorkspaceState };
