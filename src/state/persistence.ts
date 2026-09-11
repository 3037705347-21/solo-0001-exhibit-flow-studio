import type { IssueStatus, WorkspaceState } from '../domain/models';
import { createSeedWorkspace } from './seed';
import { migrateWorkspace, validateReferences } from './migrations';

export const STORAGE_KEY = 'exhibit-flow.workspace.v1';
export const REVIEW_UI_KEY = 'exhibit-flow.review-ui.v1';
export const RECOVERY_KEY = 'exhibit-flow.workspace-recovered.v1';

/**
 * Revision of every unmodified baseline (fresh sample plan or a migrated
 * legacy document). The first observable write advances it to revision 2.
 */
export const FIRST_REVISION = 1;

const ENVELOPE_FORMAT = 'exhibit-flow-workspace';
const ENVELOPE_VERSION = 2;

export interface StoredWorkspace {
  format: typeof ENVELOPE_FORMAT;
  formatVersion: typeof ENVELOPE_VERSION;
  revision: number;
  writtenAt: string;
  workspace: WorkspaceState;
}

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

type ParsedSession =
  | { kind: 'session'; workspace: WorkspaceState; revision: number; legacy: boolean }
  | { kind: 'missing' }
  | { kind: 'invalid' };

/**
 * Parse the raw stored document. Accepts the current envelope and the legacy
 * bare workspace shape; anything else is reported as invalid so callers can
 * preserve it before falling back to the sample plan.
 */
function parseStored(raw: string | null): ParsedSession {
  if (raw == null || raw === '') return { kind: 'missing' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'invalid' };
  }
  if (!parsed || typeof parsed !== 'object') return { kind: 'invalid' };
  const envelope = parsed as Partial<StoredWorkspace>;
  if (envelope.format === ENVELOPE_FORMAT) {
    if (envelope.formatVersion !== ENVELOPE_VERSION || typeof envelope.revision !== 'number' || !Number.isInteger(envelope.revision) || envelope.revision < FIRST_REVISION) {
      return { kind: 'invalid' };
    }
    if (!isWorkspaceState(envelope.workspace)) return { kind: 'invalid' };
    return { kind: 'session', workspace: validateReferences(envelope.workspace), revision: envelope.revision, legacy: false };
  }
  const migrated = migrateWorkspace(parsed);
  if (!migrated || !isWorkspaceState(migrated)) return { kind: 'invalid' };
  // Legacy documents predate revision coordination; they anchor the first revision.
  return { kind: 'session', workspace: validateReferences(migrated), revision: FIRST_REVISION, legacy: true };
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Move an unreadable document aside so a later write can never destroy it. */
function stashCorruptStorage(storage: Pick<Storage, 'getItem' | 'setItem'>, raw: string): boolean {
  try {
    const existing = storage.getItem(RECOVERY_KEY);
    if (existing) return true; // an earlier unreadable copy was already preserved
    storage.setItem(RECOVERY_KEY, JSON.stringify({ recoveredAt: new Date().toISOString(), raw }));
    return true;
  } catch {
    return false;
  }
}

export interface LoadedSession {
  workspace: WorkspaceState;
  revision: number;
  /** True when the stored document could not be read and was kept for recovery. */
  recovered: boolean;
  /** True when storage held a pre-coordination (bare v1) document. */
  legacy: boolean;
}

function seedSession(): { workspace: WorkspaceState; revision: number } {
  return { workspace: createSeedWorkspace(), revision: FIRST_REVISION };
}

export function loadWorkspace(storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): LoadedSession {
  let raw: string | null = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    // Storage itself is unreadable; keep the seed in memory without touching storage.
    return { ...seedSession(), recovered: false, legacy: false };
  }
  const parsed = parseStored(raw);
  if (parsed.kind === 'session') {
    return { workspace: parsed.workspace, revision: parsed.revision, recovered: false, legacy: parsed.legacy };
  }
  if (parsed.kind === 'invalid') {
    stashCorruptStorage(storage, raw as string);
    return { ...seedSession(), recovered: true, legacy: false };
  }
  return { ...seedSession(), recovered: false, legacy: false };
}

export type CommitOutcome =
  | { kind: 'committed'; workspace: WorkspaceState; revision: number }
  | { kind: 'conflict'; current: WorkspaceState; currentRevision: number }
  | { kind: 'unavailable' };

/**
 * Compare-and-swap commit. The write only lands when storage still holds the
 * revision the change was based on. The serialized document is read back and
 * verified; if the write appears interrupted the previous document is restored
 * so storage is never left in a worse state than before the call.
 */
export function commitWorkspace(
  workspace: WorkspaceState,
  expectedRevision: number,
  storage: StorageLike = localStorage as StorageLike,
): CommitOutcome {
  let previousRaw: string | null = null;
  try {
    previousRaw = storage.getItem(STORAGE_KEY);
  } catch {
    return { kind: 'unavailable' };
  }

  const seen = parseStored(previousRaw);
  if (seen.kind === 'invalid') {
    // The on-disk document is unreadable. Preserve it but do not overwrite it
    // automatically: the session reloads the sample plan and must adopt it
    // explicitly before a new document can be written.
    stashCorruptStorage(storage, previousRaw as string);
    return { kind: 'unavailable' };
  }
  if (seen.kind === 'session') {
    if (seen.revision !== expectedRevision) {
      return { kind: 'conflict', current: seen.workspace, currentRevision: seen.revision };
    }
  } else if (expectedRevision !== FIRST_REVISION) {
    // The saved document this change was based on has disappeared.
    return { kind: 'conflict', current: seedSession().workspace, currentRevision: FIRST_REVISION };
  }

  const nextRevision = expectedRevision + 1;
  const envelope: StoredWorkspace = {
    format: ENVELOPE_FORMAT,
    formatVersion: ENVELOPE_VERSION,
    revision: nextRevision,
    writtenAt: new Date().toISOString(),
    workspace,
  };

  let serialized: string;
  try {
    serialized = JSON.stringify(envelope);
  } catch {
    return { kind: 'unavailable' };
  }

  try {
    storage.setItem(STORAGE_KEY, serialized);
  } catch {
    return { kind: 'unavailable' };
  }

  // Verify the interrupted-write contract: the exact document must be readable back.
  let verified: string | null = null;
  try {
    verified = storage.getItem(STORAGE_KEY);
  } catch {
    verified = null;
  }
  if (verified !== serialized) {
    try {
      if (previousRaw == null) storage.removeItem(STORAGE_KEY);
      else storage.setItem(STORAGE_KEY, previousRaw);
    } catch {
      // Restoration is best effort; the write itself was reported as a failure.
    }
    return { kind: 'unavailable' };
  }

  return { kind: 'committed', workspace, revision: nextRevision };
}

export type MigrationOutcome =
  | { kind: 'migrated'; revision: number }
  | { kind: 'advanced'; revision: number }
  | { kind: 'unavailable' };

/**
 * Wrap an existing pre-coordination document in the versioned envelope without
 * changing its content. Succeeds only while storage still holds the same
 * legacy document, so the migration is idempotent across multiple tabs.
 */
export function commitInitialMigration(
  workspace: WorkspaceState,
  storage: StorageLike = localStorage as StorageLike,
): MigrationOutcome {
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return { kind: 'unavailable' };
  }
  const seen = parseStored(raw);
  if (seen.kind === 'invalid') return { kind: 'unavailable' };
  if (seen.kind === 'missing') return { kind: 'unavailable' };
  if (!seen.legacy) return { kind: 'advanced', revision: seen.revision };
  if (JSON.stringify(seen.workspace) !== JSON.stringify(workspace)) {
    // Another tab already migrated and wrote a revision.
    return { kind: 'advanced', revision: seen.revision };
  }
  const envelope: StoredWorkspace = {
    format: ENVELOPE_FORMAT,
    formatVersion: ENVELOPE_VERSION,
    revision: FIRST_REVISION,
    writtenAt: new Date().toISOString(),
    workspace,
  };
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(envelope));
    return { kind: 'migrated', revision: FIRST_REVISION };
  } catch {
    return { kind: 'unavailable' };
  }
}

export function clearWorkspace(storage: Pick<Storage, 'removeItem'> = localStorage): void {
  storage.removeItem(STORAGE_KEY);
}

/**
 * Unconditional write used by explicitly confirmed destructive actions (reset
 * to the sample plan). The revision continues from whatever is currently saved
 * so other tabs still observe a single forward step.
 */
export function overwriteWorkspace(
  workspace: WorkspaceState,
  storage: StorageLike = localStorage as StorageLike,
): Exclude<CommitOutcome, { kind: 'conflict' }> {
  let currentRevision = FIRST_REVISION - 1;
  try {
    const seen = parseStored(storage.getItem(STORAGE_KEY));
    if (seen.kind === 'session') currentRevision = seen.revision;
  } catch {
    return { kind: 'unavailable' };
  }
  const envelope: StoredWorkspace = {
    format: ENVELOPE_FORMAT,
    formatVersion: ENVELOPE_VERSION,
    revision: currentRevision + 1,
    writtenAt: new Date().toISOString(),
    workspace,
  };
  let serialized: string;
  try {
    serialized = JSON.stringify(envelope);
    storage.setItem(STORAGE_KEY, serialized);
  } catch {
    return { kind: 'unavailable' };
  }
  let verified: string | null = null;
  try {
    verified = storage.getItem(STORAGE_KEY);
  } catch {
    verified = null;
  }
  if (verified !== serialized) return { kind: 'unavailable' };
  return { kind: 'committed', workspace, revision: currentRevision + 1 };
}

/**
 * Finish recovery: keep the stashed copy for inspection but clear the corrupt
 * main document so the session (showing the sample plan) can save again. The
 * main key is only removed when it still fails to parse.
 */
export function dismissRecovery(storage: StorageLike = localStorage as StorageLike): void {
  try {
    storage.removeItem(RECOVERY_KEY);
    if (parseStored(storage.getItem(STORAGE_KEY)).kind === 'invalid') {
      storage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Recovery stashes are non-critical.
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
