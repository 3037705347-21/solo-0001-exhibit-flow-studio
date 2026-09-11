import type { IssueStatus, WorkspaceState } from '../domain/models';
import { createSeedWorkspace } from './seed';
import { migrateWorkspace, validateReferences } from './migrations';
import { normalizeWorkspaceShape, repairBrokenReferences } from '../domain/workspaceValidation';
import { recoverInterruptedRestore, type RestoreStorage } from './restore';

export const STORAGE_KEY = 'exhibit-flow.workspace.v1';
export const REVIEW_UI_KEY = 'exhibit-flow.review-ui.v1';

export interface ReviewUiState {
  zoneId: string;
  status: IssueStatus | 'all';
}

const DEFAULT_REVIEW_UI: ReviewUiState = { zoneId: '', status: 'all' };
const ISSUE_STATUSES: Array<IssueStatus | 'all'> = ['all', 'open', 'in-progress', 'resolved'];

export interface LoadWorkspaceOptions {
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /**
   * When true, an interrupted restore is rolled back before loading. The app
   * uses this so a crash mid-restore never strands the user on a half-written
   * workspace; tests can disable it to inspect raw behavior.
   */
  recover?: boolean;
}

export interface LoadWorkspaceResult {
  state: WorkspaceState;
  /** Set when an interrupted restore was rolled back during this load. */
  recoveredFromInterruption: boolean;
  /** Set when storage content was unreadable and the sample plan was substituted. */
  fellBackToSeed: boolean;
}

function isStorageHealthyShape(value: unknown): value is WorkspaceState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WorkspaceState>;
  return Boolean(candidate.project)
    && Array.isArray(candidate.artifacts)
    && Array.isArray(candidate.zones)
    && Array.isArray(candidate.issues)
    && Boolean(candidate.preferences);
}

/**
 * Loads local storage through the same validation path as imports. Legacy
 * versions are migrated non-interactively and dangling references are pruned,
 * preserving the historical read behavior. When an interrupted restore backup
 * exists it is rolled back first, so the previous known-good workspace wins.
 */
export function loadWorkspace(options: LoadWorkspaceOptions = {}): LoadWorkspaceResult {
  const storage = (options.storage ?? localStorage) as RestoreStorage;
  const recover = options.recover ?? true;
  let recoveredFromInterruption = false;
  if (recover) {
    const outcome = recoverInterruptedRestore(storage);
    recoveredFromInterruption = Boolean(outcome.recovered);
  }
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) {
      return { state: assertUsable(createSeedWorkspace()), recoveredFromInterruption, fellBackToSeed: false };
    }
    const parsed: unknown = JSON.parse(raw);
    const migrated = migrateWorkspace(parsed);
    if (migrated && isStorageHealthyShape(migrated)) {
      return { state: validateReferences(migrated), recoveredFromInterruption, fellBackToSeed: false };
    }
    return { state: assertUsable(createSeedWorkspace()), recoveredFromInterruption, fellBackToSeed: true };
  } catch {
    return { state: assertUsable(createSeedWorkspace()), recoveredFromInterruption, fellBackToSeed: true };
  }
}

/** Runs the sample (or any candidate) plan through the shared structural path. */
export function assertUsable(state: WorkspaceState): WorkspaceState {
  const normalized = normalizeWorkspaceShape(state);
  if (!normalized || !normalized.state) {
    throw new Error('Workspace failed structural validation.');
  }
  return repairBrokenReferences(normalized.state);
}

export function saveWorkspace(state: WorkspaceState, storage: Pick<Storage, 'setItem'> = localStorage): boolean {
  const normalized = normalizeWorkspaceShape(state);
  if (!normalized || !normalized.state) return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(normalized.state));
    return true;
  } catch {
    return false;
  }
}

export function clearWorkspace(storage: Pick<Storage, 'removeItem'> = localStorage): void {
  storage.removeItem(STORAGE_KEY);
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
