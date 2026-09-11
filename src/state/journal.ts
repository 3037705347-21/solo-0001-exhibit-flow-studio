import type { Artifact, IssueStatus, PlanningPreferences, ReviewIssue, WorkspaceState } from '../domain/models';
import type { WorkspaceAction } from './actions';
import { workspaceReducer } from './reducer';

/**
 * Recoverable command log ("journal").
 *
 * Every workspace mutation is recorded as a self-contained journal entry that
 * carries enough fact to replay the command through the same reducer the pages
 * use. The log is stored as newline-delimited records so a write interrupted
 * mid-record only damages the final line; every record also carries its own
 * integrity checksum. Parsing is deliberately tolerant: it stops at the first
 * record that cannot be trusted, marks that break point, and keeps every valid
 * record before it.
 */

export const JOURNAL_KEY = 'exhibit-flow.workspace.journal.v1';
export const JOURNAL_KIND = 'exhibit-flow.journal';
export const JOURNAL_VERSION = 1;

export interface JournalEntry {
  seq: number;
  id: string;
  at: string;
  action: WorkspaceAction;
}

export interface JournalBreak {
  /** Sequence number the recovery stopped at, when known. */
  seq: number | null;
  reason: string;
}

export interface ParsedJournal {
  generation: string;
  baseSeq: number;
  entries: JournalEntry[];
  /** Records skipped because they were already present (same id or an old seq). */
  duplicates: number;
  /** Set when the stored log was truncated, corrupt, or had a gap. */
  breakPoint: JournalBreak | null;
  /** Records at/after the break point that had to be left behind. */
  dropped: number;
}

export interface ReplayResult {
  state: WorkspaceState;
  applied: number;
  duplicates: number;
  breakPoint: JournalBreak | null;
}

export interface RecoveryReport {
  source: 'checkpoint' | 'journal' | 'seed';
  checkpointSeq: number;
  replayed: number;
  duplicatesSkipped: number;
  /** Known entries at/after a break point that could not be recovered. */
  discarded: number;
  corruptCheckpoint: boolean;
  breakPoint: JournalBreak | null;
}

/** FNV-1a 32-bit — a lightweight integrity check for torn or truncated writes. */
export function checksumOf(value: unknown): string {
  const text = JSON.stringify(value) ?? '';
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const ISSUE_STATUSES: IssueStatus[] = ['open', 'in-progress', 'resolved'];

/**
 * Validates a decoded JSON record back into a replayable action. Returns null
 * for anything that does not match a known command shape — such records mark a
 * break point instead of being applied.
 */
export function decodeAction(value: unknown): WorkspaceAction | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  switch (value.type) {
    case 'artifact/upsert':
      return isRecord(value.artifact)
        ? { type: 'artifact/upsert', artifact: value.artifact as unknown as Artifact }
        : null;
    case 'artifact/remove':
      return typeof value.artifactId === 'string'
        ? { type: 'artifact/remove', artifactId: value.artifactId }
        : null;
    case 'placement/assign': {
      if (typeof value.artifactId !== 'string' || typeof value.zoneId !== 'string') return null;
      if (value.index !== undefined && typeof value.index !== 'number') return null;
      return {
        type: 'placement/assign',
        artifactId: value.artifactId,
        zoneId: value.zoneId,
        index: value.index as number | undefined,
      };
    }
    case 'placement/remove':
      return typeof value.artifactId === 'string'
        ? { type: 'placement/remove', artifactId: value.artifactId }
        : null;
    case 'placement/reorder':
      return typeof value.zoneId === 'string' && typeof value.artifactId === 'string'
        && (value.direction === -1 || value.direction === 1)
        ? { type: 'placement/reorder', zoneId: value.zoneId, artifactId: value.artifactId, direction: value.direction }
        : null;
    case 'issue/add':
      return isRecord(value.issue)
        ? { type: 'issue/add', issue: value.issue as unknown as ReviewIssue }
        : null;
    case 'issue/transition': {
      if (typeof value.issueId !== 'string') return null;
      if (!ISSUE_STATUSES.includes(value.status as IssueStatus)) return null;
      let at: Date | undefined;
      if (value.at !== undefined) {
        const parsed = value.at instanceof Date ? value.at : (typeof value.at === 'string' ? new Date(value.at) : null);
        if (!parsed || Number.isNaN(parsed.getTime())) return null;
        at = parsed;
      }
      return { type: 'issue/transition', issueId: value.issueId, status: value.status as IssueStatus, at };
    }
    case 'preferences/update':
      return isRecord(value.preferences)
        ? { type: 'preferences/update', preferences: value.preferences as unknown as PlanningPreferences }
        : null;
    case 'project/readiness':
      return typeof value.ready === 'boolean' && typeof value.checkedAt === 'string'
        ? { type: 'project/readiness', ready: value.ready, checkedAt: value.checkedAt }
        : null;
    case 'workspace/reset':
      return isRecord(value.state)
        ? { type: 'workspace/reset', state: value.state as unknown as WorkspaceState }
        : null;
    default:
      return null;
  }
}

interface JournalData {
  generation: string;
  baseSeq: number;
  entries: JournalEntry[];
}

/** Serializes the journal: a header line plus one checksummed record per line. */
export function formatJournal(journal: JournalData): string {
  const header = JSON.stringify({
    kind: JOURNAL_KIND,
    version: JOURNAL_VERSION,
    generation: journal.generation,
    baseSeq: journal.baseSeq,
  });
  const lines = journal.entries.map((entry) => {
    const payload = { seq: entry.seq, id: entry.id, at: entry.at, action: entry.action };
    return JSON.stringify({ ...payload, checksum: checksumOf(payload) });
  });
  return [header, ...lines].join('\n');
}

export function writeJournal(
  storage: Pick<Storage, 'setItem'>,
  journal: JournalData,
): boolean {
  try {
    storage.setItem(JOURNAL_KEY, formatJournal(journal));
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses the stored journal, tolerating damage. Returns null only when the
 * header itself is unreadable; otherwise returns every valid record up to the
 * first untrustworthy one and marks that break point. Duplicate records (same
 * id, or a sequence number already covered) are skipped, never applied twice.
 */
export function readJournal(storage: Pick<Storage, 'getItem'>): ParsedJournal | null {
  let raw: string | null;
  try {
    raw = storage.getItem(JOURNAL_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  const lines = raw.split('\n');
  let header: unknown;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return null;
  }
  if (!isRecord(header) || header.kind !== JOURNAL_KIND || header.version !== JOURNAL_VERSION) return null;
  if (typeof header.baseSeq !== 'number' || !Number.isInteger(header.baseSeq) || header.baseSeq < 0) return null;
  const generation = typeof header.generation === 'string' ? header.generation : '';

  const entries: JournalEntry[] = [];
  const seenIds = new Set<string>();
  let duplicates = 0;
  let breakPoint: JournalBreak | null = null;
  let dropped = 0;
  let expectedSeq = header.baseSeq + 1;

  /** Counts the records left behind when the parse stops at `lineIndex`. */
  const countDropped = (lineIndex: number): number =>
    lines.slice(lineIndex).filter((line) => line.trim().length > 0).length;

  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      breakPoint = { seq: expectedSeq, reason: 'A log record was cut off mid-write.' };
      dropped = countDropped(lineIndex);
      break;
    }
    if (!isRecord(record)
      || typeof record.seq !== 'number' || !Number.isInteger(record.seq)
      || typeof record.id !== 'string'
      || typeof record.at !== 'string'
      || typeof record.checksum !== 'string'
      || !('action' in record)) {
      breakPoint = { seq: expectedSeq, reason: 'A log record is malformed.' };
      dropped = countDropped(lineIndex);
      break;
    }
    const { seq, id, at, action } = record;
    if (checksumOf({ seq, id, at, action }) !== record.checksum) {
      breakPoint = { seq, reason: 'A log record failed its integrity check.' };
      dropped = countDropped(lineIndex);
      break;
    }
    const decoded = decodeAction(action);
    if (!decoded) {
      breakPoint = { seq, reason: `Log record ${seq} holds a command that cannot be replayed.` };
      dropped = countDropped(lineIndex);
      break;
    }
    if (seenIds.has(id) || seq < expectedSeq) {
      duplicates += 1;
      continue;
    }
    if (seq > expectedSeq) {
      breakPoint = { seq, reason: 'The command log has a gap; later records were left unapplied.' };
      dropped = countDropped(lineIndex);
      break;
    }
    seenIds.add(id);
    entries.push({ seq, id, at, action: decoded });
    expectedSeq = seq + 1;
  }
  return { generation, baseSeq: header.baseSeq, entries, duplicates, breakPoint, dropped };
}

/**
 * Replays journal entries in order through the workspace reducer — the same
 * code path the pages use — so the recovered state follows the same domain
 * rules. Stops at the first entry that cannot be applied and reports it as the
 * break point, keeping everything recovered before it.
 */
export function replayJournal(base: WorkspaceState, entries: JournalEntry[]): ReplayResult {
  let state = base;
  let applied = 0;
  let duplicates = 0;
  let breakPoint: JournalBreak | null = null;
  const seenIds = new Set<string>();
  let expectedSeq = entries.length > 0 ? entries[0].seq : 0;

  for (const entry of entries) {
    if (seenIds.has(entry.id)) {
      duplicates += 1;
      continue;
    }
    if (entry.seq !== expectedSeq) {
      breakPoint = { seq: entry.seq, reason: 'The command log has a gap; later records were left unapplied.' };
      break;
    }
    try {
      state = workspaceReducer(state, entry.action);
    } catch (error) {
      breakPoint = {
        seq: entry.seq,
        reason: `Command ${entry.seq} could not be replayed: ${error instanceof Error ? error.message : 'unknown error'}`,
      };
      break;
    }
    seenIds.add(entry.id);
    applied += 1;
    expectedSeq = entry.seq + 1;
  }
  return { state, applied, duplicates, breakPoint };
}
