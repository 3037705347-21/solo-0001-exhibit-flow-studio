import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { STORAGE_KEY, loadWorkspace } from './persistence';
import { WorkspaceProvider, useWorkspace } from './WorkspaceContext';
import { createSeedWorkspace } from './seed';
import { serializeWorkspaceFile } from '../domain/workspaceFile';

const currentVersionFile = () => serializeWorkspaceFile({
  ...createSeedWorkspace(),
  project: { ...createSeedWorkspace().project, title: 'Recovery Fixture Exhibition' },
});

function wrapper({ children }: { children: ReactNode }) {
  return <WorkspaceProvider>{children}</WorkspaceProvider>;
}

describe('workspace recovery commands', () => {
  afterEach(() => localStorage.clear());

  it('rejects an un-restorable import without touching the current workspace', async () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    const beforeTitle = result.current.state.project.title;
    const beforeBytes = localStorage.getItem(STORAGE_KEY);

    let preview: { ok: boolean; reason?: string } = { ok: true };
    await act(async () => {
      preview = await result.current.previewWorkspaceImport('{"schemaVersion":1}');
    });
    expect(preview.ok).toBe(false);
    expect(preview.reason).toMatch(/snapshot/);
    expect(result.current.state.project.title).toBe(beforeTitle);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(beforeBytes);
  });

  it('commits a reviewed recovery and rolls it back to the previous workspace', async () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull());

    let planResult: { ok: boolean; reason?: string; plan?: import('./migrations').MigrationPlan } = { ok: false };
    await act(async () => {
      const response = await result.current.previewWorkspaceImport(currentVersionFile());
      planResult = response;
    });
    expect(planResult.ok).toBe(true);
    if (!planResult.ok || !planResult.plan) return;
    const plan = planResult.plan;

    act(() => {
      const commit = result.current.commitRecovery(plan, {}, 'current-v2.json');
      expect(commit.ok).toBe(true);
    });

    expect(result.current.state.version).toBe(2);
    expect(result.current.state.project.title).toBe('Recovery Fixture Exhibition');
    expect(result.current.state.restoredFrom?.sourceVersion).toBe(2);
    expect(loadWorkspace().project.title).toBe('Recovery Fixture Exhibition');

    act(() => {
      const undone = result.current.undoLastRecovery();
      expect(undone.ok).toBe(true);
    });
    expect(result.current.state.project.title).toBe(createSeedWorkspace().project.title);
    expect(loadWorkspace().project.title).toBe(createSeedWorkspace().project.title);
    expect(result.current.lastRecovery).toBeNull();
  });

  it('exports the current workspace as a re-importable v2 file', () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    const exported = result.current.exportWorkspaceFile();
    expect(exported.ok).toBe(true);
    const parsed = JSON.parse(exported.value!) as { kind: string; fileVersion: number };
    expect(parsed.kind).toBe('exhibit-flow.workspace-file');
    expect(parsed.fileVersion).toBe(2);
  });
});
