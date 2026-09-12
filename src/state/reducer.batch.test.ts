import { describe, expect, it } from 'vitest';
import type { Artifact, BatchTransactionRecord, WorkspaceState } from '../domain/models';
import { createSeedWorkspace } from './seed';
import { workspaceReducer } from './reducer';

function readyState(): WorkspaceState {
  const seed = createSeedWorkspace();
  return { ...seed, project: { ...seed.project, stage: 'ready' } };
}

const record: BatchTransactionRecord = {
  id: 'batch-reducer-1',
  createdAt: '2026-09-12T08:00:00.000Z',
  committedAt: '2026-09-12T09:00:00.000Z',
  itemCount: 2,
  artifactIds: ['artifact-lantern', 'artifact-radio'],
  fields: ['sensitivity'],
  appliedRevision: '2026-09-12T09:00:00.000Z',
};

function updatedArtifacts(state: WorkspaceState): Artifact[] {
  return state.artifacts
    .filter((artifact) => record.artifactIds.includes(artifact.id))
    .map((artifact) => ({ ...artifact, sensitivity: 'fragile' as const, updatedAt: record.appliedRevision }));
}

describe('batch commit reducer', () => {
  it('applies all artifacts in one action, appends exactly one audit record, and regresses a ready project', () => {
    const initial = readyState();
    const next = workspaceReducer(initial, { type: 'artifact/batchCommit', artifacts: updatedArtifacts(initial), record });
    expect(next.project.stage).toBe('review');
    expect(next.batchTransactions).toHaveLength(1);
    expect(next.batchTransactions[0].id).toBe(record.id);
    expect(next.artifacts.find((a) => a.id === 'artifact-lantern')!.sensitivity).toBe('fragile');
    expect(next.artifacts.find((a) => a.id === 'artifact-radio')!.sensitivity).toBe('fragile');
    expect(next.artifacts.find((a) => a.id === 'artifact-press')!.sensitivity).toBe('standard');
    expect(next.lastSavedAt).toBeTruthy();
  });

  it('ignores a repeated dispatch of the same transaction id (duplicate submit)', () => {
    const initial = readyState();
    const once = workspaceReducer(initial, { type: 'artifact/batchCommit', artifacts: updatedArtifacts(initial), record });
    const twice = workspaceReducer(once, { type: 'artifact/batchCommit', artifacts: updatedArtifacts(initial), record });
    expect(twice).toBe(once);
    expect(twice.batchTransactions).toHaveLength(1);
  });

  it('does not move stage when the plan is not ready', () => {
    const initial = createSeedWorkspace();
    expect(initial.project.stage).toBe('review');
    const next = workspaceReducer(initial, { type: 'artifact/batchCommit', artifacts: updatedArtifacts(initial), record });
    expect(next.project.stage).toBe('review');
  });
});
