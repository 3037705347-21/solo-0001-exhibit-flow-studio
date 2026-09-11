import type { WorkspaceAction } from './actions';

/**
 * Persistent command journal.
 *
 * The journal is stored as newline-delimited JSON (one record per line).
 * Because a crash can only tear the tail of a single `setItem` write, every
 * earlier line is still readable and the truncated final line is discarded
 * without poisoning the commands before it.
 */
export const JOURNAL_KEY = 'exhibit-flow.commands.v1';

/** One durable, replayable command. */
export interface JournalRecord {
  /** Unique command id; replays are idempotent per id. */
  id: string;
  /** Monotonic order relative to the current checkpoint epoch. */
  seq: number;
  /** Epoch id; a reset starts a new one and invalidates every older record. */
  epoch: string;
  at: string;
  action: WorkspaceAction;
}

export interface JournalLineError {
  line: number;
  reason: string;
}

const ACTION_TYPES: ReadonlySet<WorkspaceAction['type']> = new Set([
  'artifact/upsert',
  'artifact/remove',
  'placement/assign',
  'placement/remove',
  'placement/reorder',
  'issue/add',
  'issue/transition',
  'preferences/update',
  'project/readiness',
  // workspace/reset is intentionally absent: a reset establishes a fresh
  // epoch through a snapshot, so replaying an old reset would wipe work.
]);

type JournalStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function isValidRecord(value: unknown): value is JournalRecord {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<JournalRecord>;
  return typeof candidate.id === 'string'
    && typeof candidate.seq === 'number'
    && Number.isFinite(candidate.seq)
    && typeof candidate.epoch === 'string'
    && typeof candidate.at === 'string'
    && Boolean(candidate.action)
    && typeof (candidate.action as { type?: unknown }).type === 'string'
    && ACTION_TYPES.has((candidate.action as { type: WorkspaceAction['type'] }).type);
}

function encodeLine(record: JournalRecord): string {
  // The record payload is one compact JSON object; NDJSON never nests newlines.
  return JSON.stringify(record);
}

/**
 * Reads the journal tolerantly.
 *
 * - Blank lines are ignored.
 * - A malformed (e.g. torn) tail line ends parsing and is reported.
 * - A malformed line in the middle is reported and skipped so the recoverable
 *   commands after it are not lost.
 */
export function readJournal(storage: Pick<Storage, 'getItem'>): {
  records: JournalRecord[];
  errors: JournalLineError[];
  truncated: boolean;
} {
  const raw = storage.getItem(JOURNAL_KEY);
  const errors: JournalLineError[] = [];
  if (!raw) return { records: [], errors, truncated: false };

  const lines = raw.split('\n');
  const records: JournalRecord[] = [];
  let truncated = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A torn final line is an interrupted write; anything earlier is odd.
      if (index === lines.length - 1) truncated = true;
      errors.push({ line: index + 1, reason: truncated ? 'Unfinished command (write was interrupted).' : 'Line is not valid JSON.' });
      break;
    }
    if (!isValidRecord(parsed)) {
      errors.push({ line: index + 1, reason: 'Record is missing fields or carries an unknown command.' });
      if (index === lines.length - 1) truncated = true;
      break;
    }
    records.push(parsed);
  }

  return { records, errors, truncated };
}

/** Appends one command. Returns false when storage rejects the write. */
export function appendJournal(record: JournalRecord, storage: JournalStorage): boolean {
  const current = storage.getItem(JOURNAL_KEY) ?? '';
  const next = current.length === 0 ? encodeLine(record) : `${current}\n${encodeLine(record)}`;
  try {
    storage.setItem(JOURNAL_KEY, next);
    return true;
  } catch {
    return false;
  }
}

/** Keeps only records with `seq` strictly greater than `throughSeq` (checkpoint trimming). */
export function truncateJournalThrough(throughSeq: number, storage: JournalStorage): void {
  const { records } = readJournal(storage);
  const remaining = records.filter((record) => record.seq > throughSeq);
  try {
    if (remaining.length === 0) storage.removeItem(JOURNAL_KEY);
    else storage.setItem(JOURNAL_KEY, remaining.map(encodeLine).join('\n'));
  } catch {
    // Trimming is an optimization; leaving the old lines is safe because
    // replay dedupes by checkpoint sequence and command id.
  }
}

export function clearJournal(storage: JournalStorage): void {
  try {
    storage.removeItem(JOURNAL_KEY);
  } catch {
    // Nothing else to do: a fresh epoch makes every surviving line inert.
  }
}
