import type { IssueStatus, WorkspaceState } from '../domain/models';
import { createSeedWorkspace } from './seed';
import { ensureLineage, migrateWorkspace, validateReferences } from './migrations';

export const STORAGE_KEY = 'exhibit-flow.workspace.v1';
export const REVIEW_UI_KEY = 'exhibit-flow.review-ui.v1';
export const BACKUP_FILE_KIND = 'exhibit-flow-workspace-backup';
export const BACKUP_SCHEMA_VERSION = 1;

export interface ReviewUiState {
  zoneId: string;
  status: IssueStatus | 'all';
}

const DEFAULT_REVIEW_UI: ReviewUiState = { zoneId: '', status: 'all' };
const ISSUE_STATUSES: Array<IssueStatus | 'all'> = ['all', 'open', 'in-progress', 'resolved'];

function isWorkspaceState(value: unknown): value is WorkspaceState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WorkspaceState>;
  return candidate.version === 1
    && Boolean(candidate.project)
    && Array.isArray(candidate.artifacts)
    && Array.isArray(candidate.zones)
    && Array.isArray(candidate.issues)
    && Boolean(candidate.preferences);
}

export function loadWorkspace(storage: Pick<Storage, 'getItem'> = localStorage): WorkspaceState {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return createSeedWorkspace();
    const parsed: unknown = JSON.parse(raw);
    const migrated = migrateWorkspace(parsed);
    if (!migrated || !isWorkspaceState(migrated)) return createSeedWorkspace();
    return ensureLineage(validateReferences(migrated));
  } catch {
    return createSeedWorkspace();
  }
}

export function saveWorkspace(state: WorkspaceState, storage: Pick<Storage, 'setItem'> = localStorage): boolean {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function clearWorkspace(storage: Pick<Storage, 'removeItem'> = localStorage): void {
  storage.removeItem(STORAGE_KEY);
}

/**
 * Full backup including the provenance graph. A restore round-trips lineage
 * exactly, so deleted sources and published-package dependencies remain
 * traceable.
 */
export function serializeBackup(state: WorkspaceState): string {
  return JSON.stringify({
    kind: BACKUP_FILE_KIND,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    workspace: state,
  }, null, 2);
}

export function backupFileName(date = new Date()): string {
  return `exhibit-flow-backup-${date.toISOString().slice(0, 10)}.json`;
}

export function parseBackup(raw: string): WorkspaceState | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const candidate = value as { kind?: string; workspace?: unknown };
    if (candidate.kind !== BACKUP_FILE_KIND || !candidate.workspace) return null;
    const migrated = migrateWorkspace(candidate.workspace);
    if (!migrated || !isWorkspaceState(migrated)) return null;
    return ensureLineage(validateReferences(migrated));
  } catch {
    return null;
  }
}

export function loadReviewUi(storage: Pick<Storage, 'getItem'> = localStorage): ReviewUiState {
  try {
    const raw = storage.getItem(REVIEW_UI_KEY);
    if (!raw) return DEFAULT_REVIEW_UI;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_REVIEW_UI;
    const candidate = parsed as Partial<ReviewUiState>;
    const status: IssueStatus | 'all' = ISSUE_STATUSES.includes(candidate.status as IssueStatus | 'all')
      ? (candidate.status as IssueStatus | 'all')
      : 'all';
    return {
      zoneId: typeof candidate.zoneId === 'string' ? candidate.zoneId : '',
      status,
    };
  } catch {
    return DEFAULT_REVIEW_UI;
  }
}

export function saveReviewUi(ui: ReviewUiState, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(REVIEW_UI_KEY, JSON.stringify(ui));
  } catch {
    // UI preferences are non-critical; ignore storage failures.
  }
}
