import { isCollectionFilter } from '../domain/collectionViews';
import type { CollectionFilter, IssueStatus, WorkspaceState } from '../domain/models';
import { createSeedWorkspace } from './seed';
import { migrateWorkspace, validateReferences } from './migrations';

export const STORAGE_KEY = 'exhibit-flow.workspace.v1';
export const REVIEW_UI_KEY = 'exhibit-flow.review-ui.v1';
export const COLLECTION_UI_KEY = 'exhibit-flow.collection-ui.v1';

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
    && Boolean(candidate.preferences)
    && Array.isArray(candidate.collectionViews);
}

export interface CollectionUiState {
  /** Draft rules while browsing without a saved view ("ad hoc" scratch state). */
  draft: CollectionFilter;
  /** Selected saved view by id; kind comes from the stored view, never from UI state. */
  selectedViewId: string | null;
}

const DEFAULT_COLLECTION_UI: CollectionUiState = {
  draft: { query: '', roles: [], sensitivities: [], keyOnly: false },
  selectedViewId: null,
};

export function loadWorkspace(storage: Pick<Storage, 'getItem'> = localStorage): WorkspaceState {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return createSeedWorkspace();
    const parsed: unknown = JSON.parse(raw);
    const migrated = migrateWorkspace(parsed);
    return migrated && isWorkspaceState(migrated) ? validateReferences(migrated) : createSeedWorkspace();
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

/**
 * Restore the last collection UI state. The selected view id is accepted without
 * a kind: the kind is resolved from the persisted view itself so an old UI state
 * can never resurrect a frozen list under live semantics (or vice versa).
 * Selection of a view that no longer exists is dropped on load.
 */
export function loadCollectionUi(storage: Pick<Storage, 'getItem'> = localStorage, existingViewIds: ReadonlySet<string> = new Set()): CollectionUiState {
  try {
    const raw = storage.getItem(COLLECTION_UI_KEY);
    if (!raw) return DEFAULT_COLLECTION_UI;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_COLLECTION_UI;
    const candidate = parsed as Partial<CollectionUiState>;
    if (!isCollectionFilter(candidate.draft)) return DEFAULT_COLLECTION_UI;
    const selectedViewId = typeof candidate.selectedViewId === 'string'
      && candidate.selectedViewId
      && existingViewIds.has(candidate.selectedViewId)
      ? candidate.selectedViewId
      : null;
    return { draft: candidate.draft, selectedViewId };
  } catch {
    return DEFAULT_COLLECTION_UI;
  }
}

export function saveCollectionUi(ui: CollectionUiState, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(COLLECTION_UI_KEY, JSON.stringify(ui));
  } catch {
    // UI preferences are non-critical; ignore storage failures.
  }
}
