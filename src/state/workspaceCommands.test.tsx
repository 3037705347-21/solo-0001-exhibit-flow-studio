import { act, renderHook } from '@testing-library/react';
import { type ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceProvider, useWorkspace } from './WorkspaceContext';
import { STORAGE_KEY } from './persistence';
import { createSeedWorkspace } from './seed';
import { emptyArtifactDraft, artifactToDraft } from '../domain/artifactValidation';
import type { ArtifactDraft, IssueStatus } from '../domain/models';

type SeedState = ReturnType<typeof createSeedWorkspace>;

function seedStorage(mutate?: (state: SeedState) => void): SeedState {
  const state = structuredClone(createSeedWorkspace());
  mutate?.(state);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  return state;
}

function wrapper({ children }: { children: ReactNode }) {
  return <WorkspaceProvider>{children}</WorkspaceProvider>;
}

function validDraft(overrides: Partial<ArtifactDraft> = {}): ArtifactDraft {
  return {
    ...emptyArtifactDraft,
    accessionId: 'AF-2027-900',
    title: 'Test Plaque',
    maker: 'Test Studio',
    medium: 'Cast bronze',
    summary: 'A sufficiently detailed summary describing the object and its role.',
    width: '12',
    height: '18',
    depth: '2',
    dwellMinutes: '4',
    ...overrides,
  };
}

describe('workspace commands', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('rejects duplicate accession ids, invalid dimensions, and overly short summaries', () => {
    seedStorage();
    const { result } = renderHook(() => useWorkspace(), { wrapper });

    let response: ReturnType<typeof useWorkspace>['upsertArtifact'] extends (...args: never[]) => infer R ? R : never;

    act(() => {
      response = result.current.upsertArtifact(validDraft({ accessionId: ' af-1908-014 ' }));
    });
    expect(response!.ok).toBe(false);
    expect(response!.errors?.accessionId).toMatch(/already/i);
    expect(result.current.state.artifacts).toHaveLength(8);

    act(() => {
      response = result.current.upsertArtifact(validDraft({ width: '-5' }));
    });
    expect(response!.ok).toBe(false);
    expect(response!.errors?.width).toBeTruthy();

    act(() => {
      response = result.current.upsertArtifact(validDraft({ summary: 'Too brief' }));
    });
    expect(response!.ok).toBe(false);
    expect(response!.errors?.summary).toMatch(/24 characters/);
  });

  it('creates a valid artifact and keeps it available through persistence', () => {
    seedStorage();
    const { result } = renderHook(() => useWorkspace(), { wrapper });

    let createdId = '';
    act(() => {
      const response = result.current.upsertArtifact(validDraft());
      expect(response.ok).toBe(true);
      createdId = response.value!.id;
    });

    expect(result.current.state.artifacts).toHaveLength(9);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.artifacts.some((artifact: { id: string }) => artifact.id === createdId)).toBe(true);
  });

  it('updates an existing artifact in place without allocating a new id', () => {
    seedStorage();
    const { result } = renderHook(() => useWorkspace(), { wrapper });

    const existing = result.current.state.artifacts.find((artifact) => artifact.id === 'artifact-lantern')!;
    const draft = { ...artifactToDraft(existing), title: 'Railway Signal Lantern (restored)' };

    act(() => {
      const response = result.current.upsertArtifact(draft, existing);
      expect(response.ok).toBe(true);
      expect(response.value!.id).toBe('artifact-lantern');
    });

    const artifacts = result.current.state.artifacts;
    expect(artifacts).toHaveLength(8);
    const updated = artifacts.find((artifact) => artifact.id === 'artifact-lantern')!;
    expect(updated.title).toBe('Railway Signal Lantern (restored)');
    expect(updated.createdAt).toBe(existing.createdAt);
    // Editing the artifact keeps its accession id valid against itself.
    expect(artifacts.filter((artifact) => artifact.accessionId === existing.accessionId)).toHaveLength(1);
  });

  it('moves an artifact between zones: source is cleared, target position is correct, and no duplicates remain', () => {
    seedStorage();
    const { result } = renderHook(() => useWorkspace(), { wrapper });

    act(() => {
      expect(result.current.assignArtifact('artifact-lantern', 'zone-after').ok).toBe(true);
    });

    const byId = (id: string) => result.current.state.zones.find((zone) => zone.id === id)!;
    expect(byId('zone-arrival').artifactIds).toEqual([]);
    expect(byId('zone-after').artifactIds).toEqual([
      'artifact-bowl',
      'artifact-tape',
      'artifact-lantern',
    ]);
    const totalPlacements = result.current.state.zones.flatMap((zone) => zone.artifactIds);
    expect(totalPlacements.filter((id) => id === 'artifact-lantern')).toHaveLength(1);
  });

  it('cleans up zone references and linked findings when an artifact is deleted', () => {
    seedStorage();
    const { result } = renderHook(() => useWorkspace(), { wrapper });

    act(() => {
      expect(result.current.removeArtifact('artifact-tape').ok).toBe(true);
    });

    expect(result.current.state.artifacts.some((artifact) => artifact.id === 'artifact-tape')).toBe(false);
    expect(
      result.current.state.zones.every((zone) => !zone.artifactIds.includes('artifact-tape')),
    ).toBe(true);
    expect(
      result.current.state.issues.some((issue) => issue.artifactId === 'artifact-tape'),
    ).toBe(false);
  });

  it('accepts a legal finding transition and updates the timestamp', () => {
    seedStorage();
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    const openIssueId = 'issue-entry-copy';
    const originalUpdatedAt = result.current.state.issues.find(
      (issue) => issue.id === openIssueId,
    )!.updatedAt;

    let response: { ok: boolean; message?: string } = { ok: false };
    act(() => {
      response = result.current.transitionReviewIssue(openIssueId, 'in-progress');
    });
    expect(response.ok).toBe(true);
    const moved = result.current.state.issues.find((issue) => issue.id === openIssueId)!;
    expect(moved.status).toBe('in-progress');
    expect(moved.updatedAt).not.toBe(originalUpdatedAt);
  });

  // DEFECT (see report): WorkspaceContext.transitionReviewIssue wraps dispatch in
  // try/catch and promises an { ok: false, message } result for an illegal move,
  // but React's reducer throws during the re-render triggered by dispatch, so the
  // error escapes the command instead of being converted into a result. This test
  // documents the declared contract and currently fails against the implementation.
  it('reports an illegal finding jump as a failed result instead of throwing', () => {
    seedStorage();
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    const openIssueId = 'issue-entry-copy';

    let response: { ok: boolean; message?: string } | undefined;
    expect(() => {
      act(() => {
        response = result.current.transitionReviewIssue(openIssueId, 'resolved' as IssueStatus);
      });
    }).not.toThrow();
    expect(response?.ok).toBe(false);
    expect(response?.message).toMatch(/open to resolved/);
    expect(
      result.current.state.issues.find((issue) => issue.id === openIssueId)!.status,
    ).toBe('open');
  });

  it('moves a ready plan back to review when a blocking command runs', () => {
    seedStorage((seed) => { seed.project.stage = 'ready'; });
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    expect(result.current.state.project.stage).toBe('ready');

    act(() => {
      expect(result.current.assignArtifact('artifact-gloves', 'zone-arrival').ok).toBe(true);
    });
    expect(result.current.state.project.stage).toBe('review');
  });
});
