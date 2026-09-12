import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ReviewPage } from './ReviewPage';
import { WorkspaceProvider, useWorkspace } from '../../state/WorkspaceContext';

function renderReview() {
  return render(<WorkspaceProvider><ReviewPage /></WorkspaceProvider>);
}

function createFinding(title: string) {
  fireEvent.click(screen.getByRole('button', { name: 'New finding' }));
  fireEvent.change(screen.getByLabelText('Finding title'), { target: { value: title } });
  fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'Rina Solberg' } });
  fireEvent.change(screen.getByLabelText('Linked object'), { target: { value: 'artifact-quilt' } });
  fireEvent.change(screen.getByLabelText('Context and next step'), { target: { value: 'Floor walk flagged the same lux problem at the quilt.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create finding' }));
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('review page merge transaction', () => {
  it('previews root cause, differences, links and history, then commits one canonical record', () => {
    const { container } = renderReview();
    createFinding('Quilt lux follow-up');

    // Select the new finding and the resolved seed finding on the same object.
    fireEvent.click(screen.getByLabelText('Select "Quilt lux follow-up" for merge'));
    fireEvent.click(screen.getByLabelText('Select "Confirm quilt lux rotation" for merge'));
    fireEvent.click(screen.getByRole('button', { name: 'Merge selected (2)' }));

    const dialog = screen.getByRole('dialog', { name: 'Merge duplicate findings' });
    expect(within(dialog).getByText(/All selected findings point at object "Rain Map Quilt"/)).toBeInTheDocument();
    expect(within(dialog).getByRole('table', { name: 'Field differences' })).toBeInTheDocument();
    expect(within(dialog).getByText('STATUS HISTORY')).toBeInTheDocument();
    expect(within(dialog).getByText('LINKED ZONES AND OBJECTS')).toBeInTheDocument();
    // The resolved source shows up in the status history with its resolution date.
    expect(within(dialog).getByText(/resolved Aug 28, 2026/)).toBeInTheDocument();

    const confirm = within(dialog).getByRole('button', { name: 'Confirm merge' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Merge reason/), { target: { value: 'Same lux problem reported from curation and the floor walk.' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    // One canonical record; both sources stay listed as merged evidence.
    expect(screen.getByText('Canonical · 2 merged')).toBeInTheDocument();
    expect(screen.getAllByText(/Merged into/)).toHaveLength(2);
    expect(screen.getByText(/is now the canonical record/)).toBeInTheDocument();
    // Totals count the canonical record once: 4 findings become 3 countable ones.
    const summary = screen.getByText('TOTAL FINDINGS').parentElement!;
    expect(within(summary).getByText('3')).toBeInTheDocument();

    // Repeating the same merge is a no-op and never creates a second canonical.
    const mergedCheckboxes = container.querySelectorAll('.issue-merged input[type="checkbox"]');
    expect(mergedCheckboxes).toHaveLength(2);
    fireEvent.click(mergedCheckboxes[0]);
    fireEvent.click(mergedCheckboxes[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Merge selected (2)' }));
    const repeatDialog = screen.getByRole('dialog', { name: 'Merge duplicate findings' });
    expect(within(repeatDialog).getByText(/already merged into/)).toBeInTheDocument();
    expect(within(repeatDialog).queryByRole('button', { name: 'Confirm merge' })).not.toBeInTheDocument();
    fireEvent.click(within(repeatDialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getAllByText('Canonical · 2 merged')).toHaveLength(1);
  });

  it('redirects transitions on a merged source to the canonical record', () => {
    let api!: ReturnType<typeof useWorkspace>;
    function Probe() {
      api = useWorkspace();
      return null;
    }
    render(<WorkspaceProvider><Probe /></WorkspaceProvider>);

    const ids = ['issue-entry-copy', 'issue-audio-transcript'];
    const preview = api.previewMerge(ids);
    expect(preview.ok).toBe(true);
    if (!preview.ok || !preview.value) return;

    let canonicalId = '';
    act(() => {
      const committed = api.commitMerge(ids, { reason: 'Same root problem tracked twice.', expectedFingerprint: preview.value!.fingerprint });
      expect(committed.ok).toBe(true);
      canonicalId = committed.value!.id;
    });

    const source = api.state.issues.find((issue) => issue.id === 'issue-entry-copy');
    expect(source?.mergedIntoId).toBe(canonicalId);
    expect(api.state.issues.filter((issue) => issue.merge)).toHaveLength(1);

    // A status change aimed at the source lands on the canonical record instead.
    let redirectMessage = '';
    act(() => {
      const result = api.transitionReviewIssue('issue-entry-copy', 'resolved');
      expect(result.ok).toBe(true);
      redirectMessage = result.message ?? '';
    });
    expect(redirectMessage).toContain('canonical record');

    const canonical = api.state.issues.find((issue) => issue.id === canonicalId);
    const untouchedSource = api.state.issues.find((issue) => issue.id === 'issue-entry-copy');
    expect(canonical?.status).toBe('resolved');
    expect(untouchedSource?.status).toBe('open');
  });
});
