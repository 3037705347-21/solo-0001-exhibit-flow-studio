import { describe, expect, it } from 'vitest';
import type { Artifact, PlanningPreferences, ReviewIssue, WorkspaceState } from '../domain/models';
import type { WorkspaceAction } from './actions';
import { workspaceReducer } from './reducer';
import { createSeedWorkspace } from './seed';
import {
  STORAGE_KEY,
  STORAGE_KEY_ALT,
  describeRecovery,
  loadWorkspaceRecovery,
  openWorkspaceStore,
  type WorkspaceStore,
} from './persistence';
import { JOURNAL_KEY, checksumOf, formatJournal, readJournal, type JournalEntry } from './journal';

/**
 * Recovery simulations: interrupted writes, duplicate log records, invalid
 * records, and clean startups. Every scenario cross-checks the recovered
 * state against the same command list folded through the workspace reducer —
 * the record of operations the pages actually produced.
 */

const AT = new Date('2026-09-10T12:00:00.000Z');
const STAMP = '2026-09-10T12:00:00.000Z';

function makeStorage() {
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
    removeItem: (key: string) => { map.delete(key); },
  };
  return { storage, map };
}

const seed = createSeedWorkspace();

const newArtifact: Artifact = {
  ...seed.artifacts[0],
  id: 'artifact-field-recorder',
  accessionId: 'AF-2010-045',
  title: 'Field Recorder',
  isKeyObject: false,
};

const newIssue: ReviewIssue = {
  id: 'issue-bench-label',
  title: 'Add raised-height bench label',
  description: 'The bench label needs a raised-height variant for seated visitors.',
  severity: 'warning',
  status: 'open',
  zoneId: 'zone-patterns',
  owner: 'Sam Ortiz',
  createdAt: '2026-09-09T09:00:00.000Z',
  updatedAt: '2026-09-09T09:00:00.000Z',
};

const newPreferences: PlanningPreferences = { pace: 'leisurely', accessibilityPriority: 85, groupSize: 4 };

/** A realistic command script exercising every journaled action family. */
const script: WorkspaceAction[] = [
  { type: 'artifact/upsert', artifact: newArtifact },
  { type: 'placement/assign', artifactId: newArtifact.id, zoneId: 'zone-arrival' },
  { type: 'placement/reorder', zoneId: 'zone-arrival', artifactId: newArtifact.id, direction: -1 },
  { type: 'issue/add', issue: newIssue },
  { type: 'issue/transition', issueId: newIssue.id, status: 'in-progress', at: new Date('2026-09-10T10:00:00.000Z') },
  { type: 'preferences/update', preferences: newPreferences },
  { type: 'project/readiness', ready: true, checkedAt: '2026-09-10T11:00:00.000Z' },
];

function fold(base: WorkspaceState, commands: WorkspaceAction[]): WorkspaceState {
  return commands.reduce((state, action) => workspaceReducer(state, action), base);
}

/** The provider's command pipeline: validate, journal, apply, then commit. */
function applyCommand(
  store: WorkspaceStore,
  current: WorkspaceState,
  action: WorkspaceAction,
  commit = true,
): WorkspaceState {
  workspaceReducer(current, action); // validation happens before logging
  store.journal(action, current, AT);
  const next = workspaceReducer(current, action);
  if (commit) store.commit(next);
  return next;
}

function runScript(
  storage: Parameters<typeof openWorkspaceStore>[0],
  commands: WorkspaceAction[],
  commit = true,
): WorkspaceState {
  const store = openWorkspaceStore(storage);
  let current = store.state;
  for (const action of commands) current = applyCommand(store, current, action, commit);
  return current;
}

/** Compares states ignoring the wall-clock save stamp each reducer run sets. */
function stable(state: WorkspaceState): WorkspaceState {
  return { ...state, lastSavedAt: undefined };
}

function checkpointSeq(map: Map<string, string>, key: string): number {
  const raw = map.get(key);
  if (!raw) return -1;
  try {
    const parsed = JSON.parse(raw) as { seq?: unknown };
    return typeof parsed.seq === 'number' ? parsed.seq : 0;
  } catch {
    return -1;
  }
}

/** The slot the next commit would overwrite: the one holding the older state. */
function olderCheckpointKey(map: Map<string, string>): string {
  return checkpointSeq(map, STORAGE_KEY) <= checkpointSeq(map, STORAGE_KEY_ALT) ? STORAGE_KEY : STORAGE_KEY_ALT;
}

function entry(seq: number, action: WorkspaceAction, id = `cmd-test-${seq}`): JournalEntry {
  return { seq, id, at: STAMP, action };
}

describe('normal startup', () => {
  it('loads the verified stable state without replaying anything', () => {
    const { storage, map } = makeStorage();
    const expected = runScript(storage, script);

    const recovered = loadWorkspaceRecovery(storage);
    expect(stable(recovered.state)).toEqual(stable(expected));
    expect(recovered.seq).toBe(script.length);
    expect(recovered.report).toMatchObject({
      source: 'checkpoint',
      checkpointSeq: script.length,
      replayed: 0,
      duplicatesSkipped: 0,
      discarded: 0,
      corruptCheckpoint: false,
      breakPoint: null,
    });
    // The stable state is a checksummed envelope and the journal was compacted.
    const envelope = JSON.parse(map.get(STORAGE_KEY)!) as { kind?: string; seq?: number };
    expect(envelope.kind).toBe('exhibit-flow.checkpoint');
    expect(envelope.seq).toBe(script.length);
    const journal = readJournal(storage);
    expect(journal?.entries).toHaveLength(0);
    expect(journal?.baseSeq).toBe(script.length);
    // Nothing noteworthy happened, so no recovery notice is shown.
    expect(describeRecovery(recovered.report)).toBeNull();
  });

  it('still reads workspaces saved before journaling existed', () => {
    const { storage, map } = makeStorage();
    map.set(STORAGE_KEY, JSON.stringify(seed));
    const recovered = loadWorkspaceRecovery(storage);
    expect(stable(recovered.state)).toEqual(stable(seed));
    expect(recovered.report.source).toBe('checkpoint');
  });
});

describe('interrupted writes', () => {
  it('replays journaled commands over the previous checkpoint when a checkpoint write is torn', () => {
    const { storage, map } = makeStorage();
    const store = openWorkspaceStore(storage);
    let current = store.state;
    for (const action of script.slice(0, 5)) current = applyCommand(store, current, action);
    // Two more commands are journaled, then the browser closes while the
    // checkpoint for them is being written: the slot holds partial JSON.
    current = applyCommand(store, current, script[5], false);
    current = applyCommand(store, current, script[6], false);
    const torn = JSON.stringify({ kind: 'exhibit-flow.checkpoint', version: 1, generation: '', seq: 7, state: current });
    map.set(olderCheckpointKey(map), torn.slice(0, 80));

    const recovered = loadWorkspaceRecovery(storage);
    expect(stable(recovered.state)).toEqual(stable(fold(seed, script)));
    expect(recovered.report).toMatchObject({
      source: 'journal',
      checkpointSeq: 5,
      replayed: 2,
      corruptCheckpoint: true,
      breakPoint: null,
    });
    expect(describeRecovery(recovered.report)?.tone).toBe('success');
  });

  it('keeps the valid prefix and marks the break point when the journal is cut mid-record', () => {
    const { storage, map } = makeStorage();
    const store = openWorkspaceStore(storage);
    let current = store.state;
    for (const action of script.slice(0, 5)) current = applyCommand(store, current, action);
    current = applyCommand(store, current, script[5], false);
    current = applyCommand(store, current, script[6], false);
    // The journal write itself was interrupted: the last record is partial.
    const raw = map.get(JOURNAL_KEY)!;
    map.set(JOURNAL_KEY, raw.slice(0, raw.length - 24));

    const recovered = loadWorkspaceRecovery(storage);
    expect(stable(recovered.state)).toEqual(stable(fold(seed, script.slice(0, 6))));
    expect(recovered.report.replayed).toBe(1);
    expect(recovered.report.discarded).toBe(1);
    expect(recovered.report.breakPoint).toEqual({ seq: 7, reason: 'A log record was cut off mid-write.' });
    expect(describeRecovery(recovered.report)?.tone).toBe('warning');
  });

  it('falls back to the newest verified checkpoint when the journal header is destroyed', () => {
    const { storage, map } = makeStorage();
    const store = openWorkspaceStore(storage);
    let current = store.state;
    for (const action of script.slice(0, 5)) current = applyCommand(store, current, action);
    current = applyCommand(store, current, script[5], false);
    map.set(JOURNAL_KEY, `!${map.get(JOURNAL_KEY)!.slice(1)}`);

    const recovered = loadWorkspaceRecovery(storage);
    expect(stable(recovered.state)).toEqual(stable(fold(seed, script.slice(0, 5))));
    expect(recovered.report).toMatchObject({ source: 'checkpoint', replayed: 0, breakPoint: null });
  });

  it('replays the whole log from the seed when no checkpoint was ever written', () => {
    const { storage } = makeStorage();
    runScript(storage, script.slice(0, 3), false);

    const recovered = loadWorkspaceRecovery(storage);
    expect(stable(recovered.state)).toEqual(stable(fold(seed, script.slice(0, 3))));
    expect(recovered.report).toMatchObject({ source: 'journal', checkpointSeq: 0, replayed: 3 });
  });

  it('mirrors the first checkpoint so a fresh workspace survives a torn slot', () => {
    const { storage, map } = makeStorage();
    runScript(storage, script.slice(0, 1));
    // No verified checkpoint existed before, so the first commit wrote both slots.
    expect(checkpointSeq(map, STORAGE_KEY)).toBe(1);
    expect(checkpointSeq(map, STORAGE_KEY_ALT)).toBe(1);

    map.set(STORAGE_KEY, map.get(STORAGE_KEY)!.slice(0, 60));
    const recovered = loadWorkspaceRecovery(storage);
    expect(stable(recovered.state)).toEqual(stable(fold(seed, script.slice(0, 1))));
    expect(recovered.report).toMatchObject({ source: 'checkpoint', replayed: 0, corruptCheckpoint: true });
    expect(describeRecovery(recovered.report)?.tone).toBe('warning');
  });

  it('continues the log seamlessly across a recovery', () => {
    const { storage } = makeStorage();
    const first = openWorkspaceStore(storage);
    let current = first.state;
    for (const action of script.slice(0, 4)) current = applyCommand(first, current, action);
    current = applyCommand(first, current, script[4], false); // journaled, never checkpointed

    // Reopen: the un-checkpointed command is replayed and stays pending.
    const second = openWorkspaceStore(storage);
    expect(second.report.replayed).toBe(1);
    let restored = second.state;
    for (const action of script.slice(5)) restored = applyCommand(second, restored, action);

    const recovered = loadWorkspaceRecovery(storage);
    expect(stable(recovered.state)).toEqual(stable(fold(seed, script)));
    expect(recovered.seq).toBe(script.length);
    expect(recovered.report.replayed).toBe(0);
  });
});

describe('duplicate log records', () => {
  it('never applies the same operation twice', () => {
    const { storage, map } = makeStorage();
    runScript(storage, script.slice(0, 2)); // checkpoints at seq 2

    // A rewritten log that repeats an already-checkpointed record and
    // duplicates a new one — both must be skipped, not reapplied.
    map.set(JOURNAL_KEY, formatJournal({
      generation: '',
      baseSeq: 1,
      entries: [
        entry(2, script[1], 'cmd-covered-by-checkpoint'),
        entry(3, script[2]),
        entry(3, script[2]),
        entry(4, script[3]),
      ],
    }));

    const recovered = loadWorkspaceRecovery(storage);
    expect(stable(recovered.state)).toEqual(stable(fold(seed, script.slice(0, 4))));
    // Reorder applied twice would swap back; issue added twice would duplicate.
    expect(recovered.state.zones.find((zone) => zone.id === 'zone-arrival')?.artifactIds[0]).toBe(newArtifact.id);
    expect(recovered.state.issues.filter((issue) => issue.id === newIssue.id)).toHaveLength(1);
    expect(recovered.report).toMatchObject({ replayed: 2, duplicatesSkipped: 2, breakPoint: null });
  });
});

describe('invalid log records', () => {
  function seedInvalidJournal(map: Map<string, string>, entries: JournalEntry[]): void {
    map.set(JOURNAL_KEY, formatJournal({ generation: '', baseSeq: 2, entries }));
  }

  it('stops at a record that fails its integrity check and keeps the valid prefix', () => {
    const { storage, map } = makeStorage();
    runScript(storage, script.slice(0, 2));
    seedInvalidJournal(map, [entry(3, script[2]), entry(4, script[3]), entry(5, script[4])]);
    // Corrupt one byte inside the second record without fixing its checksum.
    const lines = map.get(JOURNAL_KEY)!.split('\n');
    lines[2] = lines[2].replace('zone-patterns', 'zone-pattXrns');
    map.set(JOURNAL_KEY, lines.join('\n'));

    const recovered = loadWorkspaceRecovery(storage);
    expect(stable(recovered.state)).toEqual(stable(fold(seed, script.slice(0, 3))));
    expect(recovered.report).toMatchObject({ replayed: 1, discarded: 2 });
    expect(recovered.report.breakPoint).toEqual({ seq: 4, reason: 'A log record failed its integrity check.' });
  });

  it('marks a break point at a command that is not replayable', () => {
    const { storage, map } = makeStorage();
    runScript(storage, script.slice(0, 2));
    const bogus = entry(4, { type: 'workspace/obliterate' } as unknown as WorkspaceAction, 'cmd-bogus');
    seedInvalidJournal(map, [entry(3, script[2]), bogus, entry(5, script[4])]);

    const recovered = loadWorkspaceRecovery(storage);
    expect(stable(recovered.state)).toEqual(stable(fold(seed, script.slice(0, 3))));
    expect(recovered.report.replayed).toBe(1);
    expect(recovered.report.discarded).toBe(2);
    expect(recovered.report.breakPoint?.seq).toBe(4);
    expect(recovered.report.breakPoint?.reason).toContain('cannot be replayed');
  });

  it('marks a break point at a command that violates domain rules on replay', () => {
    const { storage, map } = makeStorage();
    runScript(storage, script.slice(0, 2));
    const illegal = entry(4, { type: 'placement/assign', artifactId: 'artifact-ghost', zoneId: 'zone-arrival' }, 'cmd-illegal');
    seedInvalidJournal(map, [entry(3, script[2]), illegal, entry(5, script[4])]);

    const recovered = loadWorkspaceRecovery(storage);
    expect(stable(recovered.state)).toEqual(stable(fold(seed, script.slice(0, 3))));
    expect(recovered.report.replayed).toBe(1);
    expect(recovered.report.discarded).toBe(2);
    expect(recovered.report.breakPoint?.seq).toBe(4);
    expect(recovered.report.breakPoint?.reason).toContain('not in the collection');
  });

  it('marks a break point at a sequence gap instead of skipping commands', () => {
    const { storage, map } = makeStorage();
    runScript(storage, script.slice(0, 2));
    seedInvalidJournal(map, [entry(3, script[2]), entry(5, script[4])]);

    const recovered = loadWorkspaceRecovery(storage);
    expect(stable(recovered.state)).toEqual(stable(fold(seed, script.slice(0, 3))));
    expect(recovered.report.replayed).toBe(1);
    expect(recovered.report.breakPoint?.seq).toBe(5);
    expect(recovered.report.breakPoint?.reason).toContain('gap');
  });
});

describe('history hygiene', () => {
  it('reset starts a clean generation and stale pre-reset history cannot resurface', () => {
    const { storage, map } = makeStorage();
    const store = openWorkspaceStore(storage);
    let current = store.state;
    for (const action of script.slice(0, 3)) current = applyCommand(store, current, action);

    const fresh = createSeedWorkspace();
    expect(store.reset(fresh)).toBe(true);
    current = fresh;

    const journalAfterReset = readJournal(storage);
    expect(journalAfterReset?.entries).toHaveLength(0);
    expect(journalAfterReset?.baseSeq).toBe(0);
    const generation = journalAfterReset?.generation ?? '';
    expect(generation).not.toBe('');
    expect(checkpointSeq(map, STORAGE_KEY)).toBe(0);
    expect(checkpointSeq(map, STORAGE_KEY_ALT)).toBe(0);

    // A pre-reset checkpoint with a high sequence number "survives" on disk.
    const staleState = fold(seed, script);
    const stale = { kind: 'exhibit-flow.checkpoint', version: 1, generation: '', seq: 99, state: staleState };
    map.set(STORAGE_KEY, JSON.stringify({ ...stale, checksum: checksumOf({ generation: '', seq: 99, state: staleState }) }));

    const postReset: WorkspaceAction[] = [
      { type: 'preferences/update', preferences: newPreferences },
      { type: 'issue/add', issue: newIssue },
    ];
    for (const action of postReset) current = applyCommand(store, current, action);

    const recovered = loadWorkspaceRecovery(storage);
    expect(stable(recovered.state)).toEqual(stable(fold(createSeedWorkspace(), postReset)));
    // The pre-reset object did not come back from the stale record.
    expect(recovered.state.artifacts.some((artifact) => artifact.id === newArtifact.id)).toBe(false);
    expect(recovered.report.replayed).toBe(0);
  });

  it('coalesces consecutive preference updates into a single log entry', () => {
    const { storage } = makeStorage();
    const store = openWorkspaceStore(storage);
    const first: PlanningPreferences = { pace: 'focused', accessibilityPriority: 40, groupSize: 2 };
    const second: PlanningPreferences = { pace: 'leisurely', accessibilityPriority: 90, groupSize: 8 };

    expect(store.journal({ type: 'preferences/update', preferences: first }, store.state)).toBe('logged');
    const intermediate = workspaceReducer(store.state, { type: 'preferences/update', preferences: first });
    expect(store.journal({ type: 'preferences/update', preferences: second }, intermediate)).toBe('coalesced');

    const journal = readJournal(storage);
    expect(journal?.entries).toHaveLength(1);
    expect(journal?.entries[0].seq).toBe(1);
    expect(journal?.entries[0].action).toMatchObject({ type: 'preferences/update', preferences: second });
  });

  it('skips readiness checks that do not move the project stage', () => {
    const { storage } = makeStorage();
    const store = openWorkspaceStore(storage);
    const review = store.state; // seed starts in 'review'

    expect(store.journal({ type: 'project/readiness', ready: false, checkedAt: STAMP }, review)).toBe('skipped');
    expect(store.journal({ type: 'project/readiness', ready: true, checkedAt: STAMP }, review)).toBe('logged');
    const ready = workspaceReducer(review, { type: 'project/readiness', ready: true, checkedAt: STAMP });
    expect(store.journal({ type: 'project/readiness', ready: true, checkedAt: '2026-09-10T12:30:00.000Z' }, ready)).toBe('skipped');
    // Resets are never appended to the log either.
    expect(store.journal({ type: 'workspace/reset', state: createSeedWorkspace() }, ready)).toBe('skipped');

    const journal = readJournal(storage);
    expect(journal?.entries).toHaveLength(1);
    expect(journal?.entries[0].action).toMatchObject({ type: 'project/readiness', ready: true });
  });
});
