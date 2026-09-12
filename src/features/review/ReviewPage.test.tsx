import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { draftFromIssue, type IssueEditInput } from '../../domain/issueRevisions';
import { WorkspaceProvider, useWorkspace } from '../../state/WorkspaceContext';
import { ReviewPage } from './ReviewPage';

let workspace: ReturnType<typeof useWorkspace>;

function ContextProbe() {
  workspace = useWorkspace();
  return null;
}

function renderReview() {
  return render(
    <WorkspaceProvider>
      <ContextProbe />
      <ReviewPage />
    </WorkspaceProvider>,
  );
}

function rowFor(title: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: title });
  const row = heading.closest('article');
  if (!row) throw new Error(`No issue row found for "${title}".`);
  return row as HTMLElement;
}

function openEdit(title: string) {
  fireEvent.click(within(rowFor(title)).getByRole('button', { name: 'Edit' }));
  return screen.getByRole('dialog');
}

function fillRationale(value: string) {
  fireEvent.change(screen.getByLabelText('Basis for change'), { target: { value } });
}

/** Simulates another page committing an edit to the same finding first. */
function externalEdit(issueId: string, draft: Partial<ReturnType<typeof draftFromIssue>>) {
  act(() => {
    const issue = workspace.state.issues.find((candidate) => candidate.id === issueId);
    if (!issue) throw new Error(`Unknown issue ${issueId}`);
    const input: IssueEditInput = {
      issueId,
      base: issue,
      draft: { ...draftFromIssue(issue), ...draft },
      editor: 'Rina Solberg',
      rationale: 'Reassigned during the curatorial standup.',
    };
    const response = workspace.saveIssueEdit(input);
    if (!response.ok) throw new Error('External edit should commit cleanly.');
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('review finding versioned edits', () => {
  it('commits a normal edit, bumps the version, and records the revision', () => {
    renderReview();
    openEdit('Reduce entry panel copy');
    fireEvent.change(screen.getByLabelText('Finding title'), { target: { value: 'Shorten entry panel copy' } });
    fillRationale('Tightened after the design review walkthrough.');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    const row = rowFor('Shorten entry panel copy');
    expect(within(row).getByText('v2')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(within(row).getByRole('button', { name: 'History' }));
    const history = screen.getByRole('dialog');
    expect(within(history).getByText('Edited')).toBeInTheDocument();
    expect(within(history).getByText('based on v1')).toBeInTheDocument();
    expect(within(history).getByText('Tightened after the design review walkthrough.')).toBeInTheDocument();
    expect(within(history).getByText('Theo James')).toBeInTheDocument();
    expect(within(history).getByText('Created')).toBeInTheDocument();
    const changeLines = history.querySelectorAll('.revision-row:first-child .change-line');
    expect(changeLines).toHaveLength(1);
    expect(changeLines[0].textContent).toContain('Reduce entry panel copy');
    expect(changeLines[0].textContent).toContain('Shorten entry panel copy');
  });

  it('requires a rationale before an edit can be committed', () => {
    renderReview();
    openEdit('Reduce entry panel copy');
    fireEvent.change(screen.getByLabelText('Finding title'), { target: { value: 'Shorten entry panel copy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByText(/Explain the basis for this change/)).toBeInTheDocument();
    expect(workspace.state.issues.find((issue) => issue.id === 'issue-entry-copy')?.title).toBe('Reduce entry panel copy');
  });

  it('detects a field conflict, then merges on confirmation', () => {
    renderReview();
    openEdit('Reduce entry panel copy');
    fireEvent.change(screen.getByLabelText('Finding title'), { target: { value: 'Shorten entry panel copy' } });
    fireEvent.change(screen.getByLabelText('Severity'), { target: { value: 'note' } });
    fillRationale('Downgraded: the panel is decorative, not interpretive.');
    // Another page edits the same finding first: new owner, critical severity.
    externalEdit('issue-entry-copy', { owner: 'Rina Solberg', severity: 'critical' });

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/changed while you were editing/)).toBeInTheDocument();
    expect(within(dialog).getByText(/CONFLICTING FIELDS/)).toBeInTheDocument();
    const clash = dialog.querySelector('.conflict-row.clash');
    expect(clash?.textContent).toContain('Severity');
    expect(clash?.textContent).toContain('critical');
    expect(clash?.textContent).toContain('note');
    expect(within(dialog).getByText(/THEIR CHANGES YOU KEEP/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge my changes' }));
    const row = rowFor('Shorten entry panel copy');
    expect(within(row).getByText('v3')).toBeInTheDocument();
    expect(within(row).getByText('Rina Solberg')).toBeInTheDocument();
    expect(row.className).toContain('issue-note');

    fireEvent.click(within(row).getByRole('button', { name: 'History' }));
    const history = screen.getByRole('dialog');
    expect(within(history).getByText('Merged edit')).toBeInTheDocument();
    expect(within(history).getByText('Edited')).toBeInTheDocument();
    expect(within(history).getByText('Created')).toBeInTheDocument();
    expect(within(history).getByText('Downgraded: the panel is decorative, not interpretive.')).toBeInTheDocument();
  });

  it('discards the edit when the user abandons a conflict', () => {
    renderReview();
    openEdit('Reduce entry panel copy');
    fireEvent.change(screen.getByLabelText('Finding title'), { target: { value: 'Shorten entry panel copy' } });
    fillRationale('Tightened after the design review walkthrough.');
    externalEdit('issue-entry-copy', { owner: 'Rina Solberg' });

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard my edit' }));

    const issue = workspace.state.issues.find((candidate) => candidate.id === 'issue-entry-copy')!;
    expect(issue.title).toBe('Reduce entry panel copy');
    expect(issue.owner).toBe('Rina Solberg');
    expect(issue.version).toBe(2);
    const revisions = workspace.state.issueHistory.filter((revision) => revision.issueId === 'issue-entry-copy');
    expect(revisions.map((revision) => revision.kind)).toEqual(['create', 'edit']);
  });

  it('applies link changes to the zone filter, checklist, and readiness result', () => {
    renderReview();
    // Scope to Afterlives: the transcript finding is listed and blocks readiness.
    fireEvent.change(screen.getByLabelText('Exhibition zone'), { target: { value: 'zone-after' } });
    expect(screen.getByText('Still needs attention')).toBeInTheDocument();
    expect(screen.getByText(/1 critical review finding remain unresolved/)).toBeInTheDocument();
    const checklist = screen.getByLabelText('Zone checklist');
    expect(within(checklist).getByText('1 open finding')).toBeInTheDocument();

    openEdit('Add transcript beside oral history station');
    fireEvent.change(screen.getByLabelText('Linked zone'), { target: { value: 'zone-arrival' } });
    fireEvent.change(screen.getByLabelText('Linked object'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Severity'), { target: { value: 'note' } });
    fillRationale('Re-scoped to the arrival zone after the floor walk.');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    // The finding leaves the Afterlives list and its checklist clears.
    expect(screen.queryByRole('heading', { name: 'Add transcript beside oral history station' })).not.toBeInTheDocument();
    const clearedChecklist = screen.getByLabelText('Zone checklist');
    expect(within(clearedChecklist).queryByText(/open finding/)).not.toBeInTheDocument();
    expect(within(clearedChecklist).getAllByText('Clear')).toHaveLength(2);
    // Readiness re-derives without a manual re-check.
    expect(screen.getByText('Ready to share')).toBeInTheDocument();

    // The finding now appears under the Arrival zone with its checklist entry.
    fireEvent.change(screen.getByLabelText('Exhibition zone'), { target: { value: 'zone-arrival' } });
    expect(screen.getByRole('heading', { name: 'Add transcript beside oral history station' })).toBeInTheDocument();
    const arrivalChecklist = screen.getByLabelText('Zone checklist');
    expect(within(arrivalChecklist).getByText(/Add transcript beside oral history station/)).toBeInTheDocument();
  });

  it('cancel leaves the finding and its history untouched', () => {
    renderReview();
    openEdit('Reduce entry panel copy');
    fireEvent.change(screen.getByLabelText('Finding title'), { target: { value: 'Shorten entry panel copy' } });
    fillRationale('Tightened after the design review walkthrough.');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const issue = workspace.state.issues.find((candidate) => candidate.id === 'issue-entry-copy')!;
    expect(issue.title).toBe('Reduce entry panel copy');
    expect(issue.version).toBe(1);
    const revisions = workspace.state.issueHistory.filter((revision) => revision.issueId === 'issue-entry-copy');
    expect(revisions).toHaveLength(1);
    expect(revisions[0].kind).toBe('create');
  });

  it('keeps the committed history after a refresh', () => {
    const first = renderReview();
    openEdit('Reduce entry panel copy');
    fireEvent.change(screen.getByLabelText('Finding title'), { target: { value: 'Shorten entry panel copy' } });
    fillRationale('Tightened after the design review walkthrough.');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(within(rowFor('Shorten entry panel copy')).getByText('v2')).toBeInTheDocument();
    first.unmount();

    renderReview();
    const row = rowFor('Shorten entry panel copy');
    expect(within(row).getByText('v2')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'History' }));
    const history = screen.getByRole('dialog');
    expect(within(history).getByText('Edited')).toBeInTheDocument();
    expect(within(history).getByText('Tightened after the design review walkthrough.')).toBeInTheDocument();
    expect(within(history).getByText('Created')).toBeInTheDocument();
  });
});
