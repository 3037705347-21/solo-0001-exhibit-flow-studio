import { analyzeJourney } from '../domain/journeyAnalysis';
import { evaluateReadiness } from '../domain/reviewRules';
import { validateReferences } from './migrations';
import { workspaceReducer } from './reducer';
import type { WorkspaceState } from '../domain/models';
import {
  appendJournal,
  clearJournal,
  readJournal,
  truncateJournalThrough,
  type JournalLineError,
  type JournalRecord,
  JOURNAL_KEY,
} from './journal';
import {
  inspectSnapshotSlots,
  LEGACY_STATE_KEY,
  loadLegacyBareState,
  writeVerifiedSnapshot,
} from './snapshotStore';
import { createSeedWorkspace } from './seed';

/** What happened while starting the workspace. */
export type RecoveryKind =
  | 'clean'
  | 'legacy-migration'
  | 'replayed'
  | 'recovered-torn-log'
  | 'recovered-torn-snapshot'
  | 'breakpoint'
  | 'seed';

export interface RecoveryBreakpoint {
  seq: number;
  commandId: string;
  commandType: string;
  at: string;
  reason: string;
}

export interface RecoveryReport {
  kind: RecoveryKind;
  /** Records successfully replayed this boot. */
  replayed: number;
  /** Command ids seen more than once and therefore applied only once. */
  duplicates: string[];
  /** Unparseable journal lines kept for diagnostics. */
  lineErrors: JournalLineError[];
  /** First command that could not be replayed; later commands were not applied. */
  breakpoint: RecoveryBreakpoint | null;
  /** Number of durable commands after the breakpoint that were held back. */
  commandsAfterBreakpoint: number;
  /** Human-readable detail, safe to show in the UI. */
  detail: string;
  /** The verified point the session started from. */
  base: 'snapshot' | 'legacy' | 'seed';
}

export interface LoadedWorkspace {
  state: WorkspaceState;
  report: RecoveryReport;
  /** Journal cursor metadata the runtime must continue from. */
  epoch: string;
  lastSeq: number;
  snapshotSlot: 'a' | 'b' | null;
}

export const CHECKPOINT_EVERY = 10;

type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function isSamePreferences(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

/**
 * Applies one journal record under the same domain rules the live pages use.
 * Throws when the command is not replayable on top of the given state.
 */
export function applyJournalRecord(state: WorkspaceState, record: JournalRecord): WorkspaceState {
  const action = record.action;
  if (action.type === 'project/readiness') {
    // The page cannot mark a plan ready without passing the readiness engine;
    // replay must express that same rule instead of trusting the stored bit.
    const analysis = analyzeJourney(state.artifacts, state.zones);
    const readiness = evaluateReadiness(state, analysis, new Date(record.at));
    if (readiness.ready !== action.ready) {
      throw new Error(
        action.ready
          ? 'Plan no longer satisfies readiness rules; the recorded "ready" command cannot be applied.'
          : 'Plan now passes readiness rules; the recorded regression command is stale.',
      );
    }
    return workspaceReducer(state, { ...action, checkedAt: record.at });
  }
  if (action.type === 'preferences/update') {
    const preferences = action.preferences;
    if (!preferences
      || !['focused', 'balanced', 'leisurely'].includes(preferences.pace)
      || typeof preferences.accessibilityPriority !== 'number'
      || typeof preferences.groupSize !== 'number') {
      throw new Error('Recorded preferences are outside the allowed visitor-profile ranges.');
    }
  }
  return workspaceReducer(state, action);
}

/** The reducer stamps wall-clock time; during replay the recorded time is truthful. */
function stampReplay(state: WorkspaceState, at: string): WorkspaceState {
  return { ...state, lastSavedAt: at };
}

function newEpoch(): string {
  return `epoch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Loads the workspace following the recovery contract:
 *
 * 1. Prefer the most recent *verified* snapshot (checksum + shape checked).
 * 2. If a snapshot write was torn, keep using the older verified snapshot and
 *    flag the interrupted save.
 * 3. Replay durable journal commands after the checkpoint, in order, skipping
 *    duplicate command ids; stop at the first command the current domain rules
 *    reject, marking a breakpoint while keeping everything replayed before it.
 * 4. First-run / fully corrupt installs start from seed data; commands logged
 *    before the first checkpoint still replay on top of that seed.
 */
export function bootstrapWorkspace(storage: RecoveryStorage): LoadedWorkspace {
  const inspection = inspectSnapshotSlots(storage);
  const snapshot = inspection.best;
  const tornSnapshot = inspection.corruptSlots.length > 0;

  const legacyRaw = snapshot ? null : storage.getItem(LEGACY_STATE_KEY);
  const legacy = snapshot ? null : loadLegacyBareState(legacyRaw);
  const journal = readJournal(storage);

  let baseState: WorkspaceState;
  let epoch: string;
  let lastSeq: number;
  let snapshotSlot: 'a' | 'b' | null;
  let base: RecoveryReport['base'];
  let detail: string;

  if (snapshot) {
    baseState = snapshot.state;
    epoch = snapshot.epoch;
    lastSeq = snapshot.seq;
    snapshotSlot = snapshot.slot;
    base = 'snapshot';
    detail = tornSnapshot
      ? 'The most recent save was interrupted; the workspace opened from the previous verified save point and newer commands were replayed.'
      : 'Opened from the last verified save point.';
  } else if (legacy) {
    baseState = legacy;
    epoch = newEpoch();
    lastSeq = 0;
    snapshotSlot = null;
    base = 'legacy';
    detail = 'Upgraded a workspace saved before command recovery existed.';
  } else {
    baseState = createSeedWorkspace();
    epoch = newEpoch();
    lastSeq = 0;
    snapshotSlot = null;
    base = 'seed';
    detail = 'Started from the sample exhibition.';
  }

  // Pre-journal installs and fresh seeds only replay commands belonging to
  // their own epoch. A seed boot adopts the newest epoch found in the log so
  // commands written before the first checkpoint are not orphaned.
  let scoped: JournalRecord[] = [];
  if (base === 'snapshot') {
    scoped = journal.records.filter((record) => record.epoch === epoch && record.seq > lastSeq);
  } else {
    const epochs = [...new Set(journal.records.map((record) => record.epoch))].sort();
    if (epochs.length > 0) {
      epoch = epochs[epochs.length - 1];
      scoped = journal.records.filter((record) => record.epoch === epoch);
    }
    if (base === 'legacy') clearJournal(storage);
  }

  const report: RecoveryReport = {
    kind: 'clean',
    replayed: 0,
    duplicates: [],
    lineErrors: journal.errors,
    breakpoint: null,
    commandsAfterBreakpoint: 0,
    detail,
    base,
  };
  if (tornSnapshot) report.kind = 'recovered-torn-snapshot';
  else if (base === 'legacy') report.kind = 'legacy-migration';
  else if (base === 'seed') report.kind = 'seed';

  let state = baseState;
  let appliedAny = false;
  let stoppedAt: JournalRecord | null = null;
  const seenIds = new Set<string>();

  for (const record of scoped) {
    if (record.seq <= lastSeq || seenIds.has(record.id)) {
      // Already represented by the checkpoint, or a repeated line for the same
      // command: applying it again would duplicate or corrupt state.
      seenIds.add(record.id);
      continue;
    }
    seenIds.add(record.id);
    try {
      const next = applyJournalRecord(state, record);
      if (next === state) {
        lastSeq = record.seq; // persisted no-op still advances the cursor
        continue;
      }
      state = stampReplay(validateReferences(next), record.at);
      lastSeq = record.seq;
      report.replayed += 1;
      appliedAny = true;
    } catch (error) {
      stoppedAt = record;
      report.breakpoint = {
        seq: record.seq,
        commandId: record.id,
        commandType: record.action.type,
        at: record.at,
        reason: error instanceof Error ? error.message : 'Command could not be replayed.',
      };
      break;
    }
  }

  if (report.duplicates.length === 0) {
    // Repeated ids anywhere in the surviving log count, even if the checkpoint
    // already covered the first occurrence.
    const counts = new Map<string, number>();
    for (const record of scoped) {
      counts.set(record.id, (counts.get(record.id) ?? 0) + 1);
    }
    report.duplicates = [...counts].filter(([, count]) => count > 1).map(([id]) => id);
  }

  if (stoppedAt) {
    const heldBack = scoped.filter((record) => record.seq > stoppedAt.seq).length;
    report.commandsAfterBreakpoint = heldBack;
    report.kind = 'breakpoint';
    report.detail = `Recovery stopped at command #${stoppedAt.seq} (${stoppedAt.action.type}): ${report.breakpoint?.reason} `
      + `${report.replayed} command${report.replayed === 1 ? '' : 's'} before it were restored; `
      + `${heldBack} later command${heldBack === 1 ? ' was' : 's were'} held back to keep the workspace consistent.`;
  } else if (journal.truncated) {
    report.kind = 'recovered-torn-log';
    report.detail = `The command log was interrupted while writing. Restored the last verified save point and replayed `
      + `${report.replayed} complete command${report.replayed === 1 ? '' : 's'}; the unfinished command was discarded.`;
  } else if (appliedAny && (report.kind === 'clean' || report.kind === 'seed')) {
    report.kind = 'replayed';
    report.detail = `Restored the verified save point and replayed ${report.replayed} command${report.replayed === 1 ? '' : 's'}.`;
  }

  // Promote the recovered result to a new verified safe point so the next boot
  // is clean. At a breakpoint only commands through the last good seq persist.
  if ((appliedAny || base === 'legacy' || tornSnapshot || (base === 'seed' && scoped.length > 0))
    && !stoppedAt) {
    const written = writeVerifiedSnapshot(storage, state, lastSeq, epoch, snapshotSlot);
    if (written.ok) {
      snapshotSlot = written.slot;
      truncateJournalThrough(lastSeq, storage);
    }
  }

  return { state, report, epoch, lastSeq, snapshotSlot };
}

/** Result of asking the runtime to durably record one workspace command. */
export type CommandCommit =
  | { journaled: true; record: JournalRecord; next: WorkspaceState }
  | { journaled: false; skipReason: string; next: WorkspaceState }
  | { ok: false; reason: string };

/**
 * Durably performs one workspace command: journal first (write-ahead), then the
 * caller dispatches the same action into the reducer. If the journal write
 * fails, the command is rejected so memory and disk never diverge.
 *
 * True no-ops (identical preferences, a readiness re-check reaching the same
 * stage, reducer no-ops) are returned unjournaled so they cannot pollute the
 * command history.
 */
export function commitCommand(
  storage: RecoveryStorage,
  state: WorkspaceState,
  action: JournalRecord['action'],
  options: { id: string; seq: number; epoch: string; at?: Date },
): CommandCommit {
  if (action.type === 'workspace/reset') {
    return { journaled: false, skipReason: 'reset', next: state };
  }
  let next: WorkspaceState;
  try {
    next = workspaceReducer(state, action);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Command rejected by domain rules.' };
  }
  if (action.type === 'preferences/update' && isSamePreferences(state.preferences, next.preferences)) {
    return { journaled: false, skipReason: 'no-op-preferences', next: state };
  }
  if (action.type === 'project/readiness' && state.project.stage === next.project.stage) {
    return { journaled: false, skipReason: 'no-op-readiness', next: state };
  }
  if (next === state) {
    return { journaled: false, skipReason: 'no-op', next: state };
  }

  const at = (options.at ?? new Date()).toISOString();
  const record: JournalRecord = { id: options.id, seq: options.seq, epoch: options.epoch, at, action };
  if (!appendJournal(record, storage)) {
    return { ok: false, reason: 'Local storage rejected the command log write.' };
  }
  return { journaled: true, record, next: stampReplay(next, at) };
}

/** Promotes the current state to a verified safe point and trims replayed commands. */
export function checkpoint(
  storage: RecoveryStorage,
  state: WorkspaceState,
  seq: number,
  epoch: string,
  previousSlot: 'a' | 'b' | null,
): { ok: true; slot: 'a' | 'b' } | { ok: false; reason: string } {
  const written = writeVerifiedSnapshot(storage, state, seq, epoch, previousSlot);
  if (!written.ok) return written;
  truncateJournalThrough(seq, storage);
  return { ok: true, slot: written.slot };
}

/**
 * Resets to a fresh plan: write and verify the new epoch's safe point first,
 * then drop the old journal. A reset is never itself a journal command, so it
 * can never be replayed over later work.
 */
export function persistReset(
  storage: RecoveryStorage,
  seed: WorkspaceState,
  epoch: string,
): { ok: true; slot: 'a' | 'b' } | { ok: false; reason: string } {
  const written = writeVerifiedSnapshot(storage, seed, 0, epoch, null);
  if (!written.ok) return written;
  clearJournal(storage);
  return { ok: true, slot: written.slot };
}

export { JOURNAL_KEY };
