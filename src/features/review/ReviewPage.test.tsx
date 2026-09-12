import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReviewPage } from './ReviewPage';
import { WorkspaceProvider, useWorkspace } from '../../state/WorkspaceContext';
import { STORAGE_KEY } from '../../state/persistence';
import type { BatchTransitionReport, WorkspaceState } from '../../domain/models';

function renderReviewPage() {
  return render(
    <WorkspaceProvider>
      <ReviewPage />
    </WorkspaceProvider>,
  );
}

function persistedWorkspace(): WorkspaceState {
  const raw = localStorage.getItem(STORAGE_KEY);
  expect(raw).toBeTruthy();
  return JSON.parse(raw as string) as WorkspaceState;
}

function batchBar(): HTMLElement {
  return screen.getByRole('region', { name: 'Batch actions' });
}

describe('review batch transitions', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
  });

  it('previews a batch and applies every valid finding in one result', () => {
    renderReviewPage();
    fireEvent.click(screen.getByLabelText('Select finding: Reduce entry panel copy'));
    fireEvent.click(screen.getByLabelText('Select finding: Confirm quilt lux rotation'));
    fireEvent.click(within(batchBar()).getByRole('button', { name: 'Start / reopen' }));

    const dialog = screen.getByRole('dialog', { name: 'Move to “In Progress”' });
    expect(within(dialog).getByText('Will update · 2')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply 2 changes' }));

    const result = screen.getByRole('dialog', { name: 'Batch result' });
    expect(within(result).getByText('Completed · 2')).toBeInTheDocument();
    expect(within(result).getByText(/2 completed · 0 already up to date · 0 need a new decision/)).toBeInTheDocument();
    expect(within(result).getAllByText('Open → In Progress')).toHaveLength(1);
    expect(within(result).getAllByText('Resolved → In Progress')).toHaveLength(1);

    fireEvent.click(within(result).getByRole('button', { name: 'Done' }));

    const workspace = persistedWorkspace();
    const started = workspace.issues.find((issue) => issue.id === 'issue-entry-copy');
    const reopened = workspace.issues.find((issue) => issue.id === 'issue-quilt-light');
    expect(started).toMatchObject({ status: 'in-progress', revision: 2 });
    expect(reopened).toMatchObject({ status: 'in-progress', revision: 2 });
    expect(reopened?.resolvedAt).toBeUndefined();
    expect(started?.lastBatchId).toBe(reopened?.lastBatchId);
    expect(workspace.processedBatches?.[started?.lastBatchId ?? ''].counts.applied).toBe(2);
  });

  it('explains mixed selections before anything is written', () => {
    renderReviewPage();
    fireEvent.click(screen.getByLabelText('Select finding: Reduce entry panel copy'));
    fireEvent.click(screen.getByLabelText('Select finding: Confirm quilt lux rotation'));
    fireEvent.click(within(batchBar()).getByRole('button', { name: 'Resolve' }));

    const dialog = screen.getByRole('dialog', { name: 'Move to “Resolved”' });
    // Open -> resolved is illegal; the resolved finding is already there.
    expect(within(dialog).getByText('Needs a new decision · 1')).toBeInTheDocument();
    expect(within(dialog).getByText('Already up to date · 1')).toBeInTheDocument();
    expect(within(dialog).getByText('A finding cannot move from open to resolved.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Nothing to apply' })).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(persistedWorkspace().issues.find((issue) => issue.id === 'issue-entry-copy')?.status).toBe('open');
  });

  it('writes nothing when the preview is cancelled', () => {
    renderReviewPage();
    fireEvent.click(screen.getByLabelText('Select finding: Reduce entry panel copy'));
    fireEvent.click(within(batchBar()).getByRole('button', { name: 'Start / reopen' }));
    expect(screen.getByText('Will update · 1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const workspace = persistedWorkspace();
    expect(workspace.issues.find((issue) => issue.id === 'issue-entry-copy')).toMatchObject({ status: 'open', revision: 1 });
    expect(workspace.processedBatches).toBeUndefined();
  });

  it('shows re-submitted items as already up to date instead of writing them again', () => {
    renderReviewPage();
    fireEvent.click(screen.getByLabelText('Select finding: Reduce entry panel copy'));
    fireEvent.click(within(batchBar()).getByRole('button', { name: 'Start / reopen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply 1 change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    // Select the same finding again and repeat the same batch action.
    fireEvent.click(screen.getByLabelText('Select finding: Reduce entry panel copy'));
    fireEvent.click(within(batchBar()).getByRole('button', { name: 'Start / reopen' }));

    const dialog = screen.getByRole('dialog', { name: 'Move to “In Progress”' });
    expect(within(dialog).getByText('Already up to date · 1')).toBeInTheDocument();
    expect(within(dialog).getByText('Already in progress — nothing was written.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Nothing to apply' })).toBeDisabled();

    const workspace = persistedWorkspace();
    expect(workspace.issues.find((issue) => issue.id === 'issue-entry-copy')?.revision).toBe(2);
    expect(Object.keys(workspace.processedBatches ?? {})).toHaveLength(1);
  });

  it('holds back externally modified findings and retries them with fresh state', () => {
    localStorage.clear();
    const harness: { workspace: ReturnType<typeof useWorkspace> | null } = { workspace: null };
    function Probe() {
      harness.workspace = useWorkspace();
      return null;
    }
    render(<WorkspaceProvider><Probe /><ReviewPage /></WorkspaceProvider>);

    fireEvent.click(screen.getByLabelText('Select finding: Reduce entry panel copy'));
    fireEvent.click(screen.getByLabelText('Select finding: Add transcript beside oral history station'));
    fireEvent.click(within(batchBar()).getByRole('button', { name: 'Start / reopen' }));
    expect(screen.getByText('Will update · 1')).toBeInTheDocument();
    expect(screen.getByText('Already up to date · 1')).toBeInTheDocument();

    // Another operation moves the in-progress finding back to open while the
    // batch dialog is open — the classic review-meeting race.
    act(() => { harness.workspace?.transitionReviewIssue('issue-audio-transcript', 'open'); });

    // The live preview re-triages: the changed finding now needs a new decision.
    expect(screen.getByText('Needs a new decision · 1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Apply 1 change' }));
    const result = screen.getByRole('dialog', { name: 'Batch result' });
    expect(within(result).getByText('Completed · 1')).toBeInTheDocument();
    expect(within(result).getByText(/Changed elsewhere since selection/)).toBeInTheDocument();

    // Retry re-decides the held-back finding against its current revision.
    fireEvent.click(within(result).getByRole('button', { name: 'Re-check 1 remaining' }));
    expect(within(screen.getByRole('dialog', { name: 'Batch result' })).getByText('Completed · 2')).toBeInTheDocument();

    const workspace = persistedWorkspace();
    // External open transition (rev 2) plus the retried batch transition (rev 3).
    expect(workspace.issues.find((issue) => issue.id === 'issue-audio-transcript')).toMatchObject({ status: 'in-progress', revision: 3 });
    expect(Object.keys(workspace.processedBatches ?? {})).toHaveLength(2);
  });
});

describe('transitionIssuesBatch command', () => {
  afterEach(() => {
    cleanup();
  });

  function renderHarness() {
    const harness: { workspace: ReturnType<typeof useWorkspace> | null } = { workspace: null };
    function Probe() {
      harness.workspace = useWorkspace();
      return null;
    }
    render(<WorkspaceProvider><Probe /></WorkspaceProvider>);
    return harness;
  }

  it('replays a repeated batch id without writing twice', () => {
    localStorage.clear();
    const harness = renderHarness();
    const intents = [{ issueId: 'issue-entry-copy', target: 'in-progress' as const, baseRevision: 1 }];

    let first: BatchTransitionReport | undefined;
    act(() => { first = harness.workspace?.transitionIssuesBatch(intents, 'batch-once'); });
    expect(first?.counts).toEqual({ applied: 1, skipped: 0, conflict: 0, invalid: 0 });

    let replay: BatchTransitionReport | undefined;
    act(() => { replay = harness.workspace?.transitionIssuesBatch(intents, 'batch-once'); });
    expect(replay).toEqual(first);

    const issue = harness.workspace?.state.issues.find((candidate) => candidate.id === 'issue-entry-copy');
    expect(issue).toMatchObject({ status: 'in-progress', revision: 2, lastBatchId: 'batch-once' });
    expect(Object.keys(harness.workspace?.state.processedBatches ?? {})).toEqual(['batch-once']);
  });

  it('reports conflicts instead of overwriting externally modified records', () => {
    localStorage.clear();
    const harness = renderHarness();
    // Another operation moves the finding first.
    act(() => { harness.workspace?.transitionReviewIssue('issue-entry-copy', 'in-progress'); });

    let report: BatchTransitionReport | undefined;
    act(() => {
      report = harness.workspace?.transitionIssuesBatch(
        [{ issueId: 'issue-entry-copy', target: 'resolved', baseRevision: 1 }],
        'batch-conflict',
      );
    });

    expect(report?.results[0]).toMatchObject({ outcome: 'conflict', reason: 'externally-modified', currentRevision: 2, currentStatus: 'in-progress' });
    const issue = harness.workspace?.state.issues.find((candidate) => candidate.id === 'issue-entry-copy');
    expect(issue).toMatchObject({ status: 'in-progress', revision: 2 });
  });
});
