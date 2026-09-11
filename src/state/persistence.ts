import type { IssueStatus, WorkspaceState } from '../domain/models';
import type { WorkspaceAction } from './actions';
import { createId } from '../domain/ids';
import { createSeedWorkspace } from './seed';
import { migrateWorkspace, validateReferences } from './migrations';
import {
  JOURNAL_KEY,
  checksumOf,
  readJournal,
  replayJournal,
  writeJournal,
  type JournalEntry,
  type ParsedJournal,
  type RecoveryReport,
} from './journal';

export const STORAGE_KEY = 'exhibit-flow.workspace.v1';
export const STORAGE_KEY_ALT = 'exhibit-flow.workspace.v1.alt';
export const REVIEW_UI_KEY = 'exhibit-flow.review-ui.v1';

const CHECKPOINT_KIND = 'exhibit-flow.checkpoint';
const CHECKPOINT_KEYS = [STORAGE_KEY, STORAGE_KEY_ALT] as const;

export interface ReviewUiState {
  zoneId: string;
  status: IssueStatus | 'all';
}

const DEFAULT_REVIEW_UI: ReviewUiState = { zoneId: '', status: 'all' };
const ISSUE_STATUSES: Array<IssueStatus | 'all'> = ['all', 'open', 'in-progress', 'resolved'];

type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

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

// ---------------------------------------------------------------------------
// Stable checkpoints
//
// The verified stable state is written as a checksummed envelope into one of
// two alternating slots, so an interrupted write damages at most one copy and
// the previous safe point always survives. The envelope carries the sequence
// number of the last journaled command it includes and a generation marker
// that changes on reset, so stale history from before a reset can never leak
// back into the recovered state.
// ---------------------------------------------------------------------------

interface Checkpoint {
  slot: 0 | 1;
  seq: number;
  generation: string;
  state: WorkspaceState;
}

interface CheckpointRead {
  checkpoint: Checkpoint | null;
  corrupt: boolean;
}

function readCheckpoint(storage: StorageReader, slot: 0 | 1): CheckpointRead {
  let raw: string | null;
  try {
    raw = storage.getItem(CHECKPOINT_KEYS[slot]);
  } catch {
    return { checkpoint: null, corrupt: true };
  }
  if (!raw) return { checkpoint: null, corrupt: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { checkpoint: null, corrupt: true };
  }
  if (parsed && typeof parsed === 'object' && (parsed as { kind?: unknown }).kind === CHECKPOINT_KIND) {
    const envelope = parsed as { version?: unknown; generation?: unknown; seq?: unknown; state?: unknown; checksum?: unknown };
    if (envelope.version !== 1
      || typeof envelope.generation !== 'string'
      || typeof envelope.seq !== 'number' || !Number.isInteger(envelope.seq) || envelope.seq < 0
      || typeof envelope.checksum !== 'string') {
      return { checkpoint: null, corrupt: true };
    }
    const { generation, seq, state } = envelope as { generation: string; seq: number; state: unknown };
    if (checksumOf({ generation, seq, state }) !== envelope.checksum) {
      return { checkpoint: null, corrupt: true };
    }
    const migrated = migrateWorkspace(state);
    if (!migrated || !isWorkspaceState(migrated)) return { checkpoint: null, corrupt: true };
    return { checkpoint: { slot, seq, generation, state: validateReferences(migrated) }, corrupt: false };
  }
  // Legacy shape: a raw WorkspaceState written before journaling existed.
  const migrated = migrateWorkspace(parsed);
  if (migrated && isWorkspaceState(migrated)) {
    return { checkpoint: { slot, seq: 0, generation: '', state: validateReferences(migrated) }, corrupt: false };
  }
  return { checkpoint: null, corrupt: true };
}

function writeCheckpoint(
  storage: Pick<Storage, 'setItem'>,
  slot: 0 | 1,
  state: WorkspaceState,
  seq: number,
  generation: string,
): boolean {
  try {
    const envelope = { kind: CHECKPOINT_KIND, version: 1, generation, seq, state };
    storage.setItem(CHECKPOINT_KEYS[slot], JSON.stringify({ ...envelope, checksum: checksumOf({ generation, seq, state }) }));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

export interface RecoveredWorkspace {
  state: WorkspaceState;
  /** Sequence number the next journaled command must use. */
  seq: number;
  generation: string;
  checkpointSlot: 0 | 1 | null;
  /** Entries replayed during recovery that no checkpoint covers yet. */
  pendingEntries: JournalEntry[];
  report: RecoveryReport;
}

/**
 * Loads the workspace, preferring the newest verified stable checkpoint and
 * then replaying any journaled commands that came after it, in order. Torn or
 * truncated writes fall back to the most recent safe point; records that
 * cannot be replayed mark a break point and everything before the break is
 * kept. Duplicate records are never applied twice.
 */
export function loadWorkspaceRecovery(storage: StorageReader = localStorage): RecoveredWorkspace {
  const slotReads = [readCheckpoint(storage, 0), readCheckpoint(storage, 1)] as const;
  const corruptCheckpoint = slotReads.some((read) => read.corrupt);
  const checkpoints = slotReads.flatMap((read) => (read.checkpoint ? [read.checkpoint] : []));
  const journal = readJournal(storage);

  // Only material from the newest generation participates; anything older
  // belongs to a workspace that has since been reset.
  const generation = [...checkpoints.map((checkpoint) => checkpoint.generation), journal?.generation ?? '']
    .reduce((newest, candidate) => (candidate > newest ? candidate : newest), '');
  const usableCheckpoints = checkpoints.filter((checkpoint) => checkpoint.generation === generation);
  const usableJournal: ParsedJournal | null = journal && journal.generation === generation ? journal : null;

  const best = usableCheckpoints.sort((a, b) => b.seq - a.seq)[0] ?? null;
  let state: WorkspaceState | null = best?.state ?? null;
  let seq = best?.seq ?? 0;
  let replayed = 0;
  let duplicatesSkipped = usableJournal?.duplicates ?? 0;
  let discarded = usableJournal?.dropped ?? 0;
  let breakPoint = usableJournal?.breakPoint ?? null;
  let pendingEntries: JournalEntry[] = [];

  if (usableJournal) {
    if (!state && usableJournal.baseSeq === 0) {
      // Every checkpoint is missing or unreadable, but the log starts from the
      // seed state, so the whole session can be replayed.
      state = createSeedWorkspace();
      seq = 0;
    }
    if (!state) {
      if (usableJournal.entries.length > 0) {
        discarded += usableJournal.entries.length;
        breakPoint = {
          seq: usableJournal.entries[0].seq,
          reason: 'No verified stable state matches the command log.',
        };
      }
    } else if (usableJournal.baseSeq > seq) {
      // The entries bridging the checkpoint and the log were compacted away;
      // replaying the remainder would skip commands, so stop before them.
      if (usableJournal.entries.length > 0) {
        discarded += usableJournal.entries.length;
        breakPoint = {
          seq: usableJournal.entries[0].seq,
          reason: 'Log entries between the stable state and this log are missing.',
        };
      }
    } else {
      const pending = usableJournal.entries.filter((entry) => entry.seq > seq);
      duplicatesSkipped += usableJournal.entries.length - pending.length;
      const replay = replayJournal(state, pending);
      state = validateReferences(replay.state);
      replayed = replay.applied;
      duplicatesSkipped += replay.duplicates;
      discarded += pending.length - replay.applied;
      if (replay.breakPoint) breakPoint = replay.breakPoint;
      seq += replay.applied;
      // The entries that were just replayed are reflected in `state` but in
      // no checkpoint yet; they stay pending until the first commit lands.
      pendingEntries = pending.slice(0, replay.applied);
    }
  }

  let source: RecoveryReport['source'];
  if (!state) {
    state = createSeedWorkspace();
    seq = 0;
    source = 'seed';
  } else {
    source = replayed > 0 ? 'journal' : (best ? 'checkpoint' : 'seed');
  }

  return {
    state,
    seq,
    generation,
    checkpointSlot: best?.slot ?? null,
    pendingEntries,
    report: {
      source,
      checkpointSeq: best?.seq ?? 0,
      replayed,
      duplicatesSkipped,
      discarded,
      corruptCheckpoint,
      breakPoint,
    },
  };
}

export interface RecoveryNotice {
  tone: 'info' | 'warning' | 'success';
  message: string;
}

/** Translates a recovery report into a user-facing notice, if one is warranted. */
export function describeRecovery(report: RecoveryReport): RecoveryNotice | null {
  if (report.source === 'seed' && (report.corruptCheckpoint || report.breakPoint)) {
    return { tone: 'warning', message: 'The saved workspace could not be read, so the sample plan was restored.' };
  }
  if (report.breakPoint) {
    const where = report.breakPoint.seq === null ? 'an unreadable record' : `log entry ${report.breakPoint.seq}`;
    const lost = report.discarded > 0 ? ` ${report.discarded} recorded change${report.discarded === 1 ? '' : 's'} could not be restored.` : '';
    return {
      tone: 'warning',
      message: `Recovered ${report.replayed} change${report.replayed === 1 ? '' : 's'} up to ${where}: ${report.breakPoint.reason}${lost}`,
    };
  }
  if (report.replayed > 0) {
    const duplicates = report.duplicatesSkipped > 0 ? ` (${report.duplicatesSkipped} duplicate record${report.duplicatesSkipped === 1 ? '' : 's'} skipped)` : '';
    return {
      tone: 'success',
      message: `Restored ${report.replayed} recent change${report.replayed === 1 ? '' : 's'} that were saved before the last session ended${duplicates}.`,
    };
  }
  if (report.corruptCheckpoint) {
    return { tone: 'warning', message: 'One saved copy of the workspace was unreadable; the latest verified copy was loaded.' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

export type JournalOutcome = 'logged' | 'coalesced' | 'skipped';

export interface WorkspaceStore {
  /** The recovered workspace state to bootstrap from. */
  readonly state: WorkspaceState;
  /** What happened while recovering this session. */
  readonly report: RecoveryReport;
  /**
   * Records a command in the journal before it is applied to state. Returns
   * how the command was logged: readiness checks that change nothing and
   * resets are skipped, and consecutive preference updates are coalesced so
   * the log stays a faithful, noise-free record of operations.
   */
  journal: (action: WorkspaceAction, current: WorkspaceState, at?: Date) => JournalOutcome;
  /** Persists the current state as a verified stable checkpoint. */
  commit: (state: WorkspaceState) => boolean;
  /** Replaces everything with a fresh generation: new log, new checkpoints. */
  reset: (state: WorkspaceState) => boolean;
}

export function openWorkspaceStore(storage: StorageWriter = localStorage): WorkspaceStore {
  const recovered = loadWorkspaceRecovery(storage);
  let seq = recovered.seq;
  let generation = recovered.generation;
  let nextSlot: 0 | 1 = recovered.checkpointSlot === 0 ? 1 : 0;
  // Entries since the last verified checkpoint — including any that recovery
  // just replayed. Keeping them pending until the next successful commit
  // preserves the invariant that the journal on disk always covers every
  // command the checkpoints do not.
  let pending: JournalEntry[] = [...recovered.pendingEntries];
  // A journal that showed damage or redundancy during recovery is rewritten
  // (compacted) once the recovered state is safely checkpointed.
  let journalDirty = recovered.report.breakPoint !== null || recovered.report.duplicatesSkipped > 0;
  // When no verified checkpoint survived into this session, the first commit
  // mirrors both slots so a single torn write cannot undo the whole workspace.
  let needsMirror = recovered.checkpointSlot === null;

  function writeJournalNow(): boolean {
    return writeJournal(storage, { generation, baseSeq: seq - pending.length, entries: pending });
  }

  return {
    state: recovered.state,
    report: recovered.report,

    journal(action, current, at = new Date()) {
      // Resets start a new generation instead of appending to dead history.
      if (action.type === 'workspace/reset') return 'skipped';
      // A readiness check that does not move the project stage is a query with
      // a timestamp side effect, not an operation worth replaying.
      if (action.type === 'project/readiness') {
        const nextStage = action.ready ? 'ready' : 'review';
        if (current.project.stage === nextStage) return 'skipped';
      }
      // Consecutive preference updates (e.g. scenario controls) collapse into
      // a single entry — replaying the latest value is equivalent.
      if (action.type === 'preferences/update') {
        const last = pending[pending.length - 1];
        if (last && last.action.type === 'preferences/update') {
          pending[pending.length - 1] = { ...last, at: at.toISOString(), action };
          writeJournalNow();
          return 'coalesced';
        }
      }
      seq += 1;
      pending.push({ seq, id: createId('cmd'), at: at.toISOString(), action });
      writeJournalNow();
      return 'logged';
    },

    commit(state) {
      const ok = writeCheckpoint(storage, nextSlot, state, seq, generation);
      if (ok) {
        if (needsMirror) {
          needsMirror = !writeCheckpoint(storage, nextSlot === 0 ? 1 : 0, state, seq, generation);
        }
        nextSlot = nextSlot === 0 ? 1 : 0;
        if (journalDirty || pending.length > 0) {
          pending = [];
          journalDirty = !writeJournalNow();
        }
      }
      return ok;
    },

    reset(state) {
      generation = new Date().toISOString();
      seq = 0;
      pending = [];
      const journalOk = writeJournalNow();
      const primary = writeCheckpoint(storage, 0, state, 0, generation);
      const secondary = writeCheckpoint(storage, 1, state, 0, generation);
      nextSlot = 0;
      journalDirty = !journalOk;
      needsMirror = false;
      return journalOk && primary && secondary;
    },
  };
}

// ---------------------------------------------------------------------------
// Compatibility helpers (pre-journal public API)
// ---------------------------------------------------------------------------

export function loadWorkspace(storage: StorageReader = localStorage): WorkspaceState {
  return loadWorkspaceRecovery(storage).state;
}

/** Writes a complete, authoritative stable state and clears any stale log. */
export function saveWorkspace(state: WorkspaceState, storage: Pick<Storage, 'setItem' | 'removeItem'> = localStorage): boolean {
  const ok = writeCheckpoint(storage, 0, state, 0, '');
  try {
    storage.removeItem(STORAGE_KEY_ALT);
    storage.removeItem(JOURNAL_KEY);
  } catch {
    // A missing removeItem only matters when stale data exists; ignore.
  }
  return ok;
}

export function clearWorkspace(storage: Pick<Storage, 'removeItem'> = localStorage): void {
  for (const key of [...CHECKPOINT_KEYS, JOURNAL_KEY]) {
    try {
      storage.removeItem(key);
    } catch {
      // Storage may be unavailable; nothing to clear then.
    }
  }
}

export function loadReviewUi(storage: StorageReader = localStorage): ReviewUiState {
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
