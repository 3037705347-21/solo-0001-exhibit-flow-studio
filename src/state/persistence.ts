import type { IssueStatus, WorkspaceState } from '../domain/models';
import { createSeedWorkspace } from './seed';
import { findWorkspaceShapeErrors, migrateWorkspace } from './migrations';

export const STORAGE_KEY = 'exhibit-flow.workspace.v1';
export const REVIEW_UI_KEY = 'exhibit-flow.review-ui.v1';

export interface ReviewUiState {
  zoneId: string;
  status: IssueStatus | 'all';
}

/** Minimal storage surface the persistence layer depends on. */
export type WorkspaceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const DEFAULT_REVIEW_UI: ReviewUiState = { zoneId: '', status: 'all' };
const ISSUE_STATUSES: Array<IssueStatus | 'all'> = ['all', 'open', 'in-progress', 'resolved'];

export function loadWorkspace(storage: Pick<Storage, 'getItem'> = localStorage): WorkspaceState {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return createSeedWorkspace();
    const parsed: unknown = JSON.parse(raw);
    const migrated = migrateWorkspace(parsed);
    return migrated && findWorkspaceShapeErrors(migrated).length === 0 ? migrated : createSeedWorkspace();
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
 * Snapshot the persisted bytes so a recovery can be rolled back. Returns null
 * when nothing is currently stored.
 */
export function readPersistedWorkspace(storage: Pick<Storage, 'getItem'> = localStorage): string | null {
  try {
    return storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export interface ReplaceResult {
  ok: boolean;
  /** The exact bytes that were in storage before the replacement. */
  previous: string | null;
  errors: string[];
}

/**
 * Validate-then-write recovery primitive. The candidate is checked against
 * the same structural rules as the sample plan BEFORE storage is touched; if
 * the write itself fails, the previous bytes (if any) are restored so the
 * existing workspace stays usable.
 */
export function replaceWorkspace(candidate: WorkspaceState, storage: WorkspaceStorage = localStorage): ReplaceResult {
  const errors = findWorkspaceShapeErrors(candidate);
  if (errors.length > 0) {
    return { ok: false, previous: readPersistedWorkspace(storage), errors };
  }
  const previous = readPersistedWorkspace(storage);
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(candidate));
    return { ok: true, previous, errors: [] };
  } catch {
    // Restore the previous bytes so a quota/serialization failure leaves the
    // original workspace intact rather than a half-written slot.
    try {
      if (previous !== null) storage.setItem(STORAGE_KEY, previous);
      else storage.removeItem(STORAGE_KEY);
    } catch {
      // Best-effort rollback; the in-memory state and retry path remain safe.
    }
    return { ok: false, previous, errors: ['The browser refused to write the recovered workspace.'] };
  }
}

/** Roll a committed recovery back to the bytes captured at commit time. */
export function rollbackWorkspace(previous: string | null, storage: WorkspaceStorage = localStorage): boolean {
  try {
    if (previous === null) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, previous);
    return true;
  } catch {
    return false;
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
