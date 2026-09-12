import type { IssueStatus, WorkspaceState } from '../domain/models';
import { reconcileRotationPlans } from '../domain/rotation';
import { createSeedWorkspace } from './seed';
import { migrateWorkspace, sanitizeRotationPlans, validateReferences } from './migrations';

export const STORAGE_KEY = 'exhibit-flow.workspace.v1';
export const REVIEW_UI_KEY = 'exhibit-flow.review-ui.v1';

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
    const validated = validateReferences({ ...migrated, rotationPlans: sanitizeRotationPlans(migrated.rotationPlans) });
    // Defensive: a plan restored from older storage is re-checked against the
    // live object/zone versions so stale plans never render as confirmed.
    return { ...validated, rotationPlans: reconcileRotationPlans(validated) };
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
