import type {
  Artifact,
  ImportBatch,
  IssueStatus,
  LineageState,
  PlanningPreferences,
  ReviewIssue,
  WorkspaceState,
} from '../domain/models';

export interface ImportPayload {
  batch: ImportBatch;
  creates: Artifact[];
  updates: Array<{ artifact: Artifact; existingId: string }>;
}

export type WorkspaceAction =
  | { type: 'artifact/upsert'; artifact: Artifact }
  | { type: 'artifact/remove'; artifactId: string }
  | { type: 'artifacts/import'; payload: ImportPayload }
  | { type: 'placement/assign'; artifactId: string; zoneId: string; index?: number }
  | { type: 'placement/remove'; artifactId: string }
  | { type: 'placement/reorder'; zoneId: string; artifactId: string; direction: -1 | 1 }
  | { type: 'issue/add'; issue: ReviewIssue }
  | { type: 'issue/transition'; issueId: string; status: IssueStatus; at?: Date }
  | { type: 'lineage/acknowledge'; nodeId: string; artifact?: Artifact }
  | { type: 'snapshot/recorded'; snapshotId: string; label: string }
  | { type: 'preferences/update'; preferences: PlanningPreferences }
  | { type: 'project/readiness'; ready: boolean; checkedAt: string }
  | { type: 'workspace/reset'; state: WorkspaceState }
  | { type: 'workspace/restore'; state: WorkspaceState }
  | { type: 'lineage/reconcile'; lineage: LineageState };
