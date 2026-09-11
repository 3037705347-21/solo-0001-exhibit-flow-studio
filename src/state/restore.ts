import { WORKSPACE_SCHEMA_VERSION, type WorkspaceState } from '../domain/models';
import { validateWorkspaceState } from '../domain/workspaceValidation';
import { STORAGE_KEY } from './persistence';

/** Storage slot holding the pre-restore workspace while a restore is committable. */
export const RESTORE_BACKUP_KEY = 'exhibit-flow.workspace.restore-backup.v1';

export interface RestoreStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface RestoreOutcome {
  ok: boolean;
  message?: string;
  /** True when an interrupted (committed but not finalized) restore was found and rolled back. */
  recovered?: boolean;
  previousSavedAt?: string;
}

interface BackupDocument {
  savedAt: string;
  serialized: string | null;
}

function readBackup(storage: RestoreStorage): BackupDocument | null {
  const raw = storage.getItem(RESTORE_BACKUP_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<BackupDocument>;
    if (typeof parsed.savedAt !== 'string') return null;
    return { savedAt: parsed.savedAt, serialized: typeof parsed.serialized === 'string' ? parsed.serialized : null };
  } catch {
    return null;
  }
}

function stampState(state: WorkspaceState, at: string): WorkspaceState {
  return { ...state, version: WORKSPACE_SCHEMA_VERSION, lastSavedAt: at };
}

/**
 * Detects a restore interrupted by a write failure or a closed tab. The backup
 * slot is the source of truth: if it exists, the previous workspace is put
 * back and storage is left in a known-good state.
 */
export function recoverInterruptedRestore(storage: RestoreStorage, at = new Date().toISOString()): RestoreOutcome {
  void at;
  const backup = readBackup(storage);
  if (!backup) return { ok: true };
  try {
    if (backup.serialized === null) {
      storage.removeItem(STORAGE_KEY);
    } else {
      storage.setItem(STORAGE_KEY, backup.serialized);
    }
    storage.removeItem(RESTORE_BACKUP_KEY);
    return { ok: true, recovered: true, previousSavedAt: backup.savedAt };
  } catch {
    // Keep the backup intact so the next startup can retry recovery; current
    // storage stays readable either way.
    return { ok: false, recovered: false, message: 'An interrupted restore could not be rolled back automatically.' };
  }
}

/**
 * Runs an all-or-nothing restore.
 *
 *  1. The candidate is validated through the shared structural path.
 *  2. The current workspace is copied into the backup slot.
 *  3. The new workspace is written.
 *
 * Any failure leaves both the original workspace and storage usable, and the
 * returned {@link RestoreHandle} lets the reviewer undo the restore for the
 * remainder of the session. If the tab closes before finalization, the backup
 * slot triggers automatic rollback on the next startup.
 */
export function commitRestore(
  state: WorkspaceState,
  storage: RestoreStorage,
  at = new Date().toISOString(),
): { ok: true; handle: RestoreHandle } | { ok: false; message: string } {
  const report = validateWorkspaceState(state);
  if (report.fatal.length > 0) {
    return { ok: false, message: report.fatal[0]?.message ?? 'The workspace failed validation and was not written.' };
  }
  const stamped = stampState(state, at);

  // Reject if a previous restore is still pending; recovery must run first.
  if (readBackup(storage)) {
    return { ok: false, message: 'An unfinished restore is pending recovery; resolve it before restoring again.' };
  }

  let previous: string | null = null;
  try {
    previous = storage.getItem(STORAGE_KEY);
  } catch {
    return { ok: false, message: 'Current storage could not be read; the restore was not started.' };
  }

  const backup: BackupDocument = { savedAt: at, serialized: previous };
  try {
    storage.setItem(RESTORE_BACKUP_KEY, JSON.stringify(backup));
  } catch {
    return { ok: false, message: 'The safety backup could not be stored; the workspace was left unchanged.' };
  }

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(stamped));
  } catch {
    // Roll the workspace key straight back and drop the backup slot.
    try {
      if (previous === null) storage.removeItem(STORAGE_KEY);
      else storage.setItem(STORAGE_KEY, previous);
      storage.removeItem(RESTORE_BACKUP_KEY);
    } catch {
      // Even if cleanup fails, the backup remains available for next-startup recovery.
    }
    return { ok: false, message: 'The restored workspace could not be written. Your previous workspace is intact.' };
  }

  return { ok: true, handle: new RestoreHandle(storage, at) };
}

/** Session-scoped handle for undoing a committed restore and finalizing it. */
export class RestoreHandle {
  private storage: RestoreStorage;
  readonly restoredAt: string;

  constructor(storage: RestoreStorage, restoredAt: string) {
    this.storage = storage;
    this.restoredAt = restoredAt;
  }

  private backup(): BackupDocument | null {
    return readBackup(this.storage);
  }

  /** Restore the previous workspace and remove the backup slot. */
  rollback(at = new Date().toISOString()): RestoreOutcome {
    const backup = this.backup();
    if (!backup) return { ok: false, message: 'This restore can no longer be undone.' };
    try {
      if (backup.serialized === null) this.storage.removeItem(STORAGE_KEY);
      else this.storage.setItem(STORAGE_KEY, backup.serialized);
      this.storage.removeItem(RESTORE_BACKUP_KEY);
      return { ok: true, previousSavedAt: at };
    } catch {
      return { ok: false, message: 'Storage rejected the rollback; the restored workspace is still in place.' };
    }
  }

  /** Reviewer accepted the result; the pre-restore backup is discarded. */
  finalize(): RestoreOutcome {
    if (!this.backup()) return { ok: true };
    try {
      this.storage.removeItem(RESTORE_BACKUP_KEY);
      return { ok: true };
    } catch {
      return { ok: false, message: 'The restore could not be finalized and will be recovered on reload.' };
    }
  }
}
