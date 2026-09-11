import { describe, expect, it } from 'vitest';
import type { WorkspaceAction } from './actions';
import { applyJournalRecord, bootstrapWorkspace, checkpoint, CHECKPOINT_EVERY, commitCommand, persistReset } from './recovery';
import { JOURNAL_KEY, type JournalRecord } from './journal';
import {
  SNAPSHOT_KEY_A,
  SNAPSHOT_KEY_B,
  writeVerifiedSnapshot,
} from './snapshotStore';
import { createSeedWorkspace } from './seed';
import { analyzeJourney } from '../domain/journeyAnalysis';
import { evaluateReadiness } from '../domain/reviewRules';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => { values.clear(); },
    key: (index: number) => [...values.keys()][index] ?? null,
    length: values.size,
  } as unknown as Storage;
}

/** Storage whose next N writes to a key fail midway, then the value is torn. */
function tearOnWrite(storage: Storage, key: string, times: number): Storage {
  let remaining = times;
  const inner = storage as unknown as {
    getItem: (k: string) => string | null;
    setItem: (k: string, v: string) => void;
    removeItem: (k: string) => void;
  };
  return {
    getItem: inner.getItem.bind(inner),
    removeItem: inner.removeItem.bind(inner),
    setItem: (k: string, v: string) => {
      if (k === key && remaining > 0) {
        remaining -= 1;
        // Simulate a crash mid-write: only a prefix of the bytes landed.
        inner.setItem(k, v.slice(0, Math.max(1, Math.floor(v.length / 3))));
        return;
      }
      inner.setItem(k, v);
    },
  } as unknown as Storage;
}

const seed = createSeedWorkspace();

function record(partial: Partial<JournalRecord> & { seq: number; action: WorkspaceAction }): JournalRecord {
  return {
    id: partial.id ?? `cmd-${partial.seq}`,
    epoch: partial.epoch ?? 'epoch-test',
    at: partial.at ?? new Date(Date.UTC(2026, 8, 10, 10, 0, partial.seq)).toISOString(),
    ...partial,
  } as JournalRecord;
}

function seedWithCommands(commands: WorkspaceAction[], options: { epoch?: string; storage?: Storage } = {}) {
  const storage = options.storage ?? memoryStorage();
  const epoch = options.epoch ?? 'epoch-test';
  let state = seed;
  // Seed starts as a verified snapshot at seq 0.
  const written = writeVerifiedSnapshot(storage, state, 0, epoch, null);
  if (!written.ok) throw new Error('snapshot setup failed');
  commands.forEach((action, index) => {
    const result = commitCommand(storage, state, action, { id: `cmd-${index + 1}`, seq: index + 1, epoch });
    if (!('journaled' in result) || !result.journaled) throw new Error(`command ${index + 1} did not journal`);
    state = result.next;
  });
  return { storage, state, epoch, slot: written.slot };
}

const addArtifactAction = (n: number): WorkspaceAction => ({
  type: 'artifact/upsert',
  artifact: {
    id: `artifact-new-${n}`,
    accessionId: `AF-2026-${String(n).padStart(3, '0')}`,
    title: `Recovery Object ${n}`,
    maker: 'Studio Test',
    yearLabel: '2026',
    medium: 'Mixed media',
    origin: 'Test lab',
    summary: 'An object created by a journaled command for recovery testing.',
    dimensions: { width: 10, height: 10, depth: 10, unit: 'cm' },
    dwellMinutes: 5,
    narrativeRole: 'reflection',
    sensitivity: 'standard',
    accessibilityNeed: 'none',
    isKeyObject: false,
    tags: [],
    color: '#444444',
    createdAt: '2026-09-10T10:00:00.000Z',
    updatedAt: '2026-09-10T10:00:00.000Z',
  },
});

describe('journal recovery', () => {
  it('normal startup: prefers the verified snapshot and replays newer commands', () => {
    const { storage, state: expected } = seedWithCommands([addArtifactAction(1), addArtifactAction(2)]);
    const loaded = bootstrapWorkspace(storage);
    expect(loaded.report.base).toBe('snapshot');
    expect(loaded.state.artifacts.map((artifact) => artifact.id))
      .toEqual(expected.artifacts.map((artifact) => artifact.id));
    expect(loaded.state.artifacts).toHaveLength(seed.artifacts.length + 2);
    expect(loaded.lastSeq).toBe(2);
  });

  it('torn journal write: replays complete commands and discards the unfinished tail', () => {
    const { storage } = seedWithCommands([addArtifactAction(1), addArtifactAction(2)]);
    // Append a third command whose write is interrupted.
    const raw = storage.getItem(JOURNAL_KEY) ?? '';
    const tornLine = JSON.stringify(record({ seq: 3, action: addArtifactAction(3) }));
    storage.setItem(JOURNAL_KEY, `${raw}\n${tornLine.slice(0, tornLine.length / 2)}`);

    const loaded = bootstrapWorkspace(storage);
    expect(loaded.report.kind).toBe('recovered-torn-log');
    expect(loaded.state.artifacts.map((a) => a.id)).toContain('artifact-new-1');
    expect(loaded.state.artifacts.map((a) => a.id)).toContain('artifact-new-2');
    expect(loaded.state.artifacts.map((a) => a.id)).not.toContain('artifact-new-3');
    expect(loaded.report.replayed).toBe(2);
    expect(loaded.report.lineErrors[0]?.reason).toMatch(/interrupted/i);
  });

  it('duplicate journal lines: the same command id is applied exactly once', () => {
    const { storage } = seedWithCommands([addArtifactAction(1)]);
    // Duplicate the cmd-1 line, then append cmd-2.
    const lines = (storage.getItem(JOURNAL_KEY) ?? '').split('\n');
    const duplicate = JSON.stringify(record({ seq: 1, id: 'cmd-1', action: addArtifactAction(1) }));
    const second = JSON.stringify(record({ seq: 2, id: 'cmd-2', action: addArtifactAction(2) }));
    storage.setItem(JOURNAL_KEY, [...lines, duplicate, second].join('\n'));

    const loaded = bootstrapWorkspace(storage);
    expect(loaded.report.duplicates).toContain('cmd-1');
    expect(loaded.state.artifacts.filter((a) => a.id === 'artifact-new-1')).toHaveLength(1);
    expect(loaded.state.artifacts.map((a) => a.id)).toContain('artifact-new-2');
    expect(loaded.report.replayed).toBe(2);
  });

  it('invalid journal command: marks a breakpoint and keeps every earlier command', () => {
    const { storage } = seedWithCommands([addArtifactAction(1)]);
    // cmd-2 places an artifact that will never exist in the collection.
    const badAction: WorkspaceAction = { type: 'placement/assign', artifactId: 'artifact-ghost', zoneId: 'zone-arrival' };
    const cmd3 = addArtifactAction(3);
    const lines = [
      JSON.stringify(record({ seq: 2, id: 'cmd-bad', action: badAction })),
      JSON.stringify(record({ seq: 3, id: 'cmd-after', action: cmd3 })),
    ];
    storage.setItem(JOURNAL_KEY, `${storage.getItem(JOURNAL_KEY) ?? ''}\n${lines.join('\n')}`);

    const loaded = bootstrapWorkspace(storage);
    expect(loaded.report.kind).toBe('breakpoint');
    expect(loaded.report.breakpoint?.seq).toBe(2);
    expect(loaded.report.breakpoint?.commandId).toBe('cmd-bad');
    expect(loaded.report.breakpoint?.reason).toMatch(/not in the collection/);
    expect(loaded.report.commandsAfterBreakpoint).toBe(1);
    expect(loaded.state.artifacts.map((a) => a.id)).toContain('artifact-new-1');
    expect(loaded.state.artifacts.map((a) => a.id)).not.toContain('artifact-new-3');
    // Every placement still references a real artifact in a real zone.
    for (const zone of loaded.state.zones) {
      for (const id of zone.artifactIds) {
        expect(loaded.state.artifacts.some((a) => a.id === id)).toBe(true);
      }
    }
  });

  it('torn snapshot write: falls back to the older verified slot without losing log commands', () => {
    const storage = memoryStorage();
    const epoch = 'epoch-test';
    const first = writeVerifiedSnapshot(storage, seed, 0, epoch, null);
    if (!first.ok) throw new Error('snapshot setup failed');
    // One command is journaled, then its snapshot write is interrupted.
    const committed = commitCommand(storage, seed, addArtifactAction(1), { id: 'cmd-1', seq: 1, epoch });
    if (!('journaled' in committed) || !committed.journaled) throw new Error('journal setup failed');
    const torn = tearOnWrite(storage, first.slot === 'a' ? SNAPSHOT_KEY_B : SNAPSHOT_KEY_A, 1);
    const broken = writeVerifiedSnapshot(torn, committed.next, 1, epoch, first.slot);
    expect(broken.ok).toBe(false);

    const loaded = bootstrapWorkspace(storage);
    expect(loaded.report.kind).toBe('recovered-torn-snapshot');
    expect(loaded.state.artifacts.map((a) => a.id)).toContain('artifact-new-1');
  });

  it('checkpoint trimming: after a verified checkpoint, replayed commands are removed from the log', () => {
    const { storage } = seedWithCommands(Array.from({ length: CHECKPOINT_EVERY }, (_, i) => addArtifactAction(i + 1)));
    // Bootstrap promotes a checkpoint when the log is long enough on replay is
    // not the path here; emulate what the app does after CHECKPOINT_EVERY.
    const loaded = bootstrapWorkspace(storage);
    // Bootstrap itself does not checkpoint without a trigger; app checkpoints
    // every CHECKPOINT_EVERY commands. Do it explicitly.
    const result = checkpoint(storage, loaded.state, loaded.lastSeq, loaded.epoch, loaded.snapshotSlot);
    expect(result.ok).toBe(true);
    expect(storage.getItem(JOURNAL_KEY)).toBeNull();
    // Reloading is now clean and needs no replay.
    const reloaded = bootstrapWorkspace(storage);
    expect(reloaded.report.replayed).toBe(0);
    expect(reloaded.state.artifacts).toHaveLength(seed.artifacts.length + CHECKPOINT_EVERY);
  });

  it('reset: starts a fresh epoch, never replays the reset or pre-reset commands', () => {
    const { storage } = seedWithCommands([addArtifactAction(1), addArtifactAction(2)]);
    const newEpoch = 'epoch-after-reset';
    const resetResult = persistReset(storage, createSeedWorkspace(), newEpoch);
    expect(resetResult.ok).toBe(true);
    // A command after the reset belongs to the new epoch.
    const after = commitCommand(storage, createSeedWorkspace(), addArtifactAction(9), { id: 'cmd-post', seq: 1, epoch: newEpoch });
    if (!('journaled' in after) || !after.journaled) throw new Error('post-reset journal failed');

    const loaded = bootstrapWorkspace(storage);
    expect(loaded.epoch).toBe(newEpoch);
    expect(loaded.state.artifacts.map((a) => a.id)).not.toContain('artifact-new-1');
    expect(loaded.state.artifacts.map((a) => a.id)).toContain('artifact-new-9');
    expect(loaded.report.breakpoint).toBeNull();
  });

  it('preferences and readiness no-ops create no journal history', () => {
    const storage = memoryStorage();
    const state = seed;
    const samePrefs = commitCommand(storage, state, { type: 'preferences/update', preferences: state.preferences }, { id: 'cmd-pref', seq: 1, epoch: 'epoch-test' });
    expect('journaled' in samePrefs && samePrefs.journaled).toBe(false);
    // Seed is already in "review" with blockers; a blocked check keeps stage
    // "review" and must not be logged.
    const readiness = evaluateReadiness(state, analyzeJourney(state.artifacts, state.zones));
    const sameStage = commitCommand(storage, state, { type: 'project/readiness', ready: readiness.ready, checkedAt: readiness.checkedAt }, { id: 'cmd-ready', seq: 2, epoch: 'epoch-test' });
    expect('journaled' in sameStage && sameStage.journaled).toBe(false);
    expect(storage.getItem(JOURNAL_KEY)).toBeNull();
  });

  it('replayed readiness commands obey the current domain rules rather than the stored bit', () => {
    // Craft a log that marks a blocked plan ready; replay must reject it.
    const storage = memoryStorage();
    writeVerifiedSnapshot(storage, seed, 0, 'epoch-test', null);
    const readiness = evaluateReadiness(seed, analyzeJourney(seed.artifacts, seed.zones));
    expect(readiness.ready).toBe(false);
    const lines = [
      JSON.stringify(record({
        seq: 1,
        id: 'cmd-fraud-ready',
        action: { type: 'project/readiness', ready: true, checkedAt: readiness.checkedAt } satisfies WorkspaceAction,
      })),
    ];
    storage.setItem(JOURNAL_KEY, lines.join('\n'));
    const loaded = bootstrapWorkspace(storage);
    expect(loaded.report.kind).toBe('breakpoint');
    expect(loaded.report.breakpoint?.commandType).toBe('project/readiness');
    expect(loaded.state.project.stage).not.toBe('ready');
  });

  it('applyJournalRecord stamps replay timestamps deterministically', () => {
    const at = '2026-09-10T10:00:00.000Z';
    const next = applyJournalRecord(seed, record({ seq: 1, at, action: addArtifactAction(1) }));
    expect(next.lastSavedAt).not.toBe(at); // reducer stamps wall-clock here
    // The bootstrap wrapper replaces the stamp with the journaled time.
    const storage = memoryStorage();
    writeVerifiedSnapshot(storage, seed, 0, 'epoch-test', null);
    storage.setItem(JOURNAL_KEY, JSON.stringify(record({ seq: 1, at, action: addArtifactAction(1) })));
    const loaded = bootstrapWorkspace(storage);
    expect(loaded.state.lastSavedAt).toBe(at);
  });
});
