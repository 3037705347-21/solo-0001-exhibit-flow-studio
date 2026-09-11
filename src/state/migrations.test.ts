import { describe, expect, it } from 'vitest';
import { parseWorkspaceFile, serializeWorkspace } from '../domain/export';
import { createSeedWorkspace } from './seed';
import {
  applyConfirmations,
  detectSourceVersion,
  isPlanResolved,
  migrateWorkspace,
  planWorkspaceMigration,
  unwrapWorkspaceFile,
  type ConfirmResolution,
} from './migrations';
import { buildImportFixture, memoryTransferStorage } from './testFixtures';
import { commitRestore, recoverInterruptedRestore, RESTORE_BACKUP_KEY } from './restore';
import { STORAGE_KEY } from './persistence';
import type { WorkspaceState } from '../domain/models';

function outcomes(plan: ReturnType<typeof planWorkspaceMigration>) {
  const counts = { added: 0, kept: 0, invalidated: 0, confirm: 0 };
  for (const change of plan.changes) counts[change.outcome] += 1;
  return counts;
}

describe('workspace version detection and unwrapping', () => {
  it('recognizes legacy, version 1, version 2, and envelope files', () => {
    expect(detectSourceVersion(buildImportFixture({ version: 2 }) as Record<string, unknown>).version).toBe(2);
    expect(detectSourceVersion(buildImportFixture({ version: 1 }) as Record<string, unknown>).version).toBe(1);
    expect(detectSourceVersion(buildImportFixture({ version: 0 }) as Record<string, unknown>).version).toBe(0);

    const wrapped = buildImportFixture({ version: 2, wrapped: true });
    const unwrapped = unwrapWorkspaceFile(wrapped);
    expect(unwrapped?.wrappedExport).toBe(true);
    expect(unwrapped?.exportedAt).toBe('2026-09-11T08:00:00.000Z');
  });

  it('refuses readiness snapshots and unknown versions', () => {
    const snapshot = { schemaVersion: 1, project: {}, summary: {}, zones: [] };
    expect(unwrapWorkspaceFile(snapshot)).toBeNull();
    const plan = planWorkspaceMigration(snapshot);
    expect(plan.candidate).toBeNull();
    expect(plan.fatal[0]?.code).toBe('unrecognized-file');

    const future = planWorkspaceMigration(buildImportFixture({ version: 99 }));
    expect(future.candidate).toBeNull();
    expect(future.fatal[0]?.code).toBe('unknown-version');
  });
});

describe('scenario 1: current-version workspace', () => {
  it('imports a v2 export with every record kept and re-exports it losslessly', () => {
    const file = buildImportFixture({ version: 2, wrapped: true });
    const plan = planWorkspaceMigration(file);
    expect(plan.sourceVersion).toBe(2);
    expect(plan.steps.map((step) => step.stageId)).toEqual(['integrity-check']);
    const counts = outcomes(plan);
    expect(counts.invalidated).toBe(0);
    expect(counts.confirm).toBe(0);
    expect(counts.added).toBe(0);
    expect(counts.kept).toBe(2 /*project+prefs*/ + 8 /*artifacts*/ + 4 /*zones*/ + 3 /*issues*/);

    const state = applyConfirmations(plan, {});
    expect(state.version).toBe(2);
    expect(state.artifacts).toHaveLength(8);

    // Re-export → re-import: same content.
    const serialized = serializeWorkspace(state);
    expect(serialized).not.toBeNull();
    const parsed = parseWorkspaceFile(serialized as string);
    expect(parsed.ok).toBe(true);
    const replan = planWorkspaceMigration((parsed as { ok: true; value: unknown }).value);
    expect(replan.candidate?.artifacts).toHaveLength(8);
    expect(outcomes(replan).added).toBe(0);
  });
});

describe('scenario 2: old-version workspace', () => {
  it('migrates version 0 through ordered steps, adding sequence and v2 preferences', () => {
    const plan = planWorkspaceMigration(buildImportFixture({ version: 0 }));
    expect(plan.sourceVersion).toBe(0);
    expect(plan.steps.map((step) => step.stageId)).toEqual([
      'legacy-v0-to-v1',
      'preferences-v1-to-v2',
      'integrity-check',
    ]);
    const stageOrder = plan.changes.map((change) => plan.steps.findIndex((step) => step.stageId === change.stageId));
    expect(stageOrder).toEqual([...stageOrder].sort((a, b) => a - b));

    const addedFields = plan.changes.filter((change) => change.outcome === 'added');
    expect(addedFields.some((change) => change.detail.includes('visit order'))).toBe(true);
    expect(addedFields.some((change) => change.label.includes('transitionBufferMinutes'))).toBe(true);
    expect(addedFields.some((change) => change.label.includes('showTransitionCues'))).toBe(true);

    const state = applyConfirmations(plan, {});
    expect(state.version).toBe(2);
    expect(state.zones.map((zone) => zone.sequence)).toEqual([0, 1, 2, 3]);
    expect(state.preferences.transitionBufferMinutes).toBe(3);
    expect(state.preferences.showTransitionCues).toBe(true);
    // Records without issues show up exactly once as kept in the final step.
    const kept = plan.changes.filter((change) => change.outcome === 'kept');
    expect(kept).toHaveLength(2 + 8 + 4 + 3);
  });

  it('migrates version 1 with only the preferences step', () => {
    const plan = planWorkspaceMigration(buildImportFixture({ version: 1 }));
    expect(plan.steps.map((step) => step.stageId)).toEqual(['preferences-v1-to-v2', 'integrity-check']);
    expect(applyConfirmations(plan, {}).preferences.transitionBufferMinutes).toBe(3);
  });
});

describe('scenario 3: missing fields', () => {
  it('repairs repairable fields, invalidates unrecoverable records, and never guesses', () => {
    const plan = planWorkspaceMigration(buildImportFixture({ version: 2, missingField: true }));
    const counts = outcomes(plan);
    expect(counts.confirm).toBe(0);
    expect(counts.invalidated).toBe(1); // gloves (no dimensions)
    expect(plan.changes.some((change) => change.outcome === 'invalidated' && change.recordId === 'artifact-gloves')).toBe(true);

    const added = plan.changes.filter((change) => change.outcome === 'added');
    expect(added.some((change) => change.detail.includes('Missing title'))).toBe(true);

    const state = applyConfirmations(plan, {});
    expect(state.artifacts).toHaveLength(7);
    const lantern = state.artifacts.find((artifact) => artifact.id === 'artifact-lantern');
    expect(lantern?.title).toBe('Untitled object');
  });
});

describe('scenario 4: broken references', () => {
  it('flags every dangling reference for human confirmation', () => {
    const plan = planWorkspaceMigration(buildImportFixture({ version: 2, brokenReferences: true }));
    expect(plan.confirmations).toHaveLength(3); // zone→artifact + issue→zone + issue→artifact
    const targets = plan.confirmations.map((confirmation) => confirmation.target).sort();
    expect(targets).toEqual(['issue.artifactId', 'issue.zoneId', 'zone.artifactIds']);
    expect(outcomes(plan).confirm).toBe(3);
    expect(isPlanResolved(plan, {})).toBe(false);

    expect(() => applyConfirmations(plan, {})).toThrow(/decision/);
  });

  it('keeps records when the reviewer drops the broken links', () => {
    const plan = planWorkspaceMigration(buildImportFixture({ version: 2, brokenReferences: true }));
    const resolutions: Record<string, ConfirmResolution> = {};
    for (const confirmation of plan.confirmations) resolutions[confirmation.id] = 'keep-with-dropped-link';
    const state = applyConfirmations(plan, resolutions);
    expect(state.zones[0].artifactIds).not.toContain('artifact-vanished');
    const issueZone = state.issues.find((issue) => issue.id === 'issue-broken-zone');
    const issueArtifact = state.issues.find((issue) => issue.id === 'issue-broken-artifact');
    expect(issueZone?.zoneId).toBeUndefined();
    expect(issueArtifact?.artifactId).toBeUndefined();
    expect(state.issues).toHaveLength(5);
  });

  it('excludes records the reviewer rejects and cascades dependent links', () => {
    const plan = planWorkspaceMigration(buildImportFixture({ version: 2, brokenReferences: true }));
    const resolutions: Record<string, ConfirmResolution> = {};
    for (const confirmation of plan.confirmations) {
      resolutions[confirmation.id] = confirmation.recordKind === 'zone' ? 'drop-record' : 'keep-with-dropped-link';
    }
    const state = applyConfirmations(plan, resolutions);
    expect(state.zones.find((zone) => zone.id === 'zone-arrival')).toBeUndefined();
    // Zone was dropped; the seed issue referencing zone-arrival cascades cleanly.
    const cascaded = state.issues.find((issue) => issue.id === 'issue-entry-copy');
    expect(cascaded?.zoneId).toBeUndefined();
  });

  it('non-interactive migration keeps the old read behavior (links pruned, records kept)', () => {
    const state = migrateWorkspace(buildImportFixture({ version: 1, brokenReferences: true }));
    expect(state?.zones[0].artifactIds).not.toContain('artifact-vanished');
    expect(state?.issues).toHaveLength(5);
  });
});

describe('scenario 5: interrupted / failed restore', () => {
  it('returns the current storage unchanged when validation before write fails', () => {
    const { values, storage } = memoryTransferStorage();
    const seed = createSeedWorkspace();
    values.set(STORAGE_KEY, JSON.stringify(seed));
    const plan = planWorkspaceMigration(buildImportFixture({ version: 2 }));
    const restored = applyConfirmations(plan, {});
    const broken = { ...restored, version: 99 } as unknown as WorkspaceState;
    const result = commitRestore(broken, storage);
    expect(result.ok).toBe(false);
    expect(JSON.parse(values.get(STORAGE_KEY) as string).project.title).toBe(seed.project.title);
    expect(values.has(RESTORE_BACKUP_KEY)).toBe(false);
  });

  it('rolls back automatically when the new-state write throws', () => {
    const { values } = memoryTransferStorage();
    const seed = createSeedWorkspace();
    values.set(STORAGE_KEY, JSON.stringify(seed));
    let mainWrites = 0;
    const transientlyFailing = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === STORAGE_KEY) {
          mainWrites += 1;
          // The restore write fails (e.g. quota); the rollback write after it succeeds.
          if (mainWrites === 1) throw new Error('quota exceeded');
        }
        values.set(key, value);
      },
      removeItem: (key: string) => { values.delete(key); },
    };
    const plan = planWorkspaceMigration(buildImportFixture({ version: 2 }));
    const restored = applyConfirmations(plan, {});
    const result = commitRestore(restored, transientlyFailing);
    expect(result.ok).toBe(false);
    expect(JSON.parse(values.get(STORAGE_KEY) as string).project.title).toBe(seed.project.title);
    expect(values.has(RESTORE_BACKUP_KEY)).toBe(false);
  });

  it('leaves a recoverable backup when rollback writes also fail', () => {
    const { values } = memoryTransferStorage();
    const seed = createSeedWorkspace();
    values.set(STORAGE_KEY, JSON.stringify(seed));
    let mainWrites = 0;
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === STORAGE_KEY) {
          mainWrites += 1;
          if (mainWrites >= 1) throw new Error('storage locked'); // restore and rollback both fail
        }
        values.set(key, value);
      },
      removeItem: () => { throw new Error('storage locked'); },
    };
    const plan = planWorkspaceMigration(buildImportFixture({ version: 2 }));
    const result = commitRestore(applyConfirmations(plan, {}), storage);
    expect(result.ok).toBe(false);
    // Original main value is untouched and the backup remains for next-startup recovery.
    expect(JSON.parse(values.get(STORAGE_KEY) as string).project.title).toBe(seed.project.title);
    expect(values.has(RESTORE_BACKUP_KEY)).toBe(true);
  });

  it('commits with a backup, supports session undo, and finalizes', () => {
    const { values, storage } = memoryTransferStorage();
    const seed = createSeedWorkspace();
    values.set(STORAGE_KEY, JSON.stringify(seed));
    const plan = planWorkspaceMigration(buildImportFixture({ version: 2 }));
    const restored = applyConfirmations(plan, {});
    const committed = commitRestore(restored, storage);
    expect(committed.ok).toBe(true);
    expect(values.has(RESTORE_BACKUP_KEY)).toBe(true);

    if (committed.ok) {
      const undone = committed.handle.rollback();
      expect(undone.ok).toBe(true);
      expect(JSON.parse(values.get(STORAGE_KEY) as string).project.title).toBe(seed.project.title);
      expect(values.has(RESTORE_BACKUP_KEY)).toBe(false);
    }
  });

  it('treats a leftover backup after a crash as an interruption and restores the original', () => {
    const seed = createSeedWorkspace();
    const newState = applyConfirmations(planWorkspaceMigration(buildImportFixture({ version: 2 })), {});
    const { values, storage } = memoryTransferStorage({
      [STORAGE_KEY]: JSON.stringify(newState),
      [RESTORE_BACKUP_KEY]: JSON.stringify({ savedAt: '2026-09-11T09:00:00.000Z', serialized: JSON.stringify(seed) }),
    });
    const outcome = recoverInterruptedRestore(storage);
    expect(outcome.recovered).toBe(true);
    expect(JSON.parse(values.get(STORAGE_KEY) as string).project.title).toBe(seed.project.title);
    expect(values.has(RESTORE_BACKUP_KEY)).toBe(false);
  });

  it('keeps storage usable when recovery write itself fails, retrying next time', () => {
    const seed = createSeedWorkspace();
    const values = new Map<string, string>([
      [STORAGE_KEY, JSON.stringify(seed)],
      [RESTORE_BACKUP_KEY, JSON.stringify({ savedAt: 'x', serialized: JSON.stringify(seed) })],
    ]);
    const failing = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: () => { throw new Error('storage locked'); },
      removeItem: () => { throw new Error('storage locked'); },
    };
    const outcome = recoverInterruptedRestore(failing);
    expect(outcome.ok).toBe(false);
    expect(values.has(RESTORE_BACKUP_KEY)).toBe(true);
  });
});
