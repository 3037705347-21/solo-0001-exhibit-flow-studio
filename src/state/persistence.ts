import type { IssueStatus, WorkspaceState } from '../domain/models';
import { createSeedWorkspace } from './seed';
import { bootstrapWorkspace, persistReset } from './recovery';
import { JOURNAL_KEY } from './journal';
import {
  LEGACY_STATE_KEY,
  inspectSnapshotSlots,
  SNAPSHOT_KEY_A,
  SNAPSHOT_KEY_B,
  writeVerifiedSnapshot,
} from './snapshotStore';

export const STORAGE_KEY = LEGACY_STATE_KEY;
export const SNAPSHOT_KEYS = [SNAPSHOT_KEY_A, SNAPSHOT_KEY_B] as const;
export const COMMAND_LOG_KEY = JOURNAL_KEY;
export const REVIEW_UI_KEY = 'exhibit-flow.review-ui.v1';

export type { RecoveryKind, RecoveryReport } from './recovery';
export {
  bootstrapWorkspace,
  checkpoint,
  commitCommand,
  persistReset,
  CHECKPOINT_EVERY,
} from './recovery';
export { readJournal, appendJournal, JOURNAL_KEY } from './journal';
export {
  fnv1a,
  inspectSnapshotSlots,
  loadVerifiedSnapshot,
  parseEnvelope,
  writeVerifiedSnapshot,
  SNAPSHOT_KEY_A,
  SNAPSHOT_KEY_B,
  LEGACY_STATE_KEY,
} from './snapshotStore';

export interface ReviewUiState {
  zoneId: string;
  status: IssueStatus | 'all';
}

const DEFAULT_REVIEW_UI: ReviewUiState = { zoneId: '', status: 'all' };
const ISSUE_STATUSES: Array<IssueStatus | 'all'> = ['all', 'open', 'in-progress', 'resolved'];

type WorkspaceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * Loads the workspace through the journal/snapshot recovery pipeline.
 * The report is available through {@link loadWorkspaceWithRecovery} for callers
 * that need to surface recovery events in the UI.
 */
export function loadWorkspace(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = localStorage): WorkspaceState {
  return bootstrapWorkspace(storage).state;
}

export function loadWorkspaceWithRecovery(storage: WorkspaceStorage = localStorage) {
  return bootstrapWorkspace(storage);
}

/**
 * Writes a standalone verified snapshot (used after migration and in tests).
 * Durable command writes go through commitCommand + checkpoint instead.
 */
export function saveWorkspace(
  state: WorkspaceState,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
  epoch = 'epoch-bootstrap',
): boolean {
  const existing = inspectSnapshotSlots(storage).best;
  const result = writeVerifiedSnapshot(storage, state, existing?.seq ?? 0, existing?.epoch ?? epoch, existing?.slot ?? null);
  return result.ok;
}

/** Resets storage and installs a verified seed snapshot. */
export function clearWorkspace(storage: WorkspaceStorage = localStorage): void {
  storage.removeItem(SNAPSHOT_KEY_A);
  storage.removeItem(SNAPSHOT_KEY_B);
  storage.removeItem(JOURNAL_KEY);
  storage.removeItem(LEGACY_STATE_KEY);
}

/** Durably resets the workspace to the sample plan on a fresh epoch. */
export function resetWorkspaceStorage(storage: WorkspaceStorage = localStorage): { ok: boolean; epoch: string } {
  const epoch = `epoch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const result = persistReset(storage, createSeedWorkspace(), epoch);
  return { ok: result.ok, epoch };
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
