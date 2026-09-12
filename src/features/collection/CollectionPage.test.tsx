import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { artifactToDraft } from '../../domain/artifactValidation';
import { useWorkspace, WorkspaceProvider } from '../../state/WorkspaceContext';
import { CollectionPage } from './CollectionPage';

function renderCollection() {
  return render(<WorkspaceProvider><CollectionPage /></WorkspaceProvider>);
}

function lanternCard(): HTMLElement {
  const heading = screen.getByRole('heading', { name: /Railway Signal Lantern|Signal Lantern/ });
  const card = heading.closest('article');
  if (!card) throw new Error('Lantern card not found.');
  return card;
}

function revisionEntry(version: number): HTMLElement {
  const label = screen.getByText(`Version ${version}`);
  const entry = label.closest('li');
  if (!entry) throw new Error(`Revision entry v${version} not found.`);
  return entry;
}

function restoreFieldButton(entry: HTMLElement, fieldLabel: string): HTMLButtonElement {
  const row = within(entry).getByText(fieldLabel).closest('.revision-change');
  if (!row) throw new Error(`No change row for ${fieldLabel}.`);
  return within(row as HTMLElement).getByRole('button', { name: 'Restore field' });
}

describe('collection revision UI', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('edits with a recorded reason, shows the diff, and restores a single field', () => {
    renderCollection();

    fireEvent.click(within(lanternCard()).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Signal Lantern (Conserved)' } });
    fireEvent.change(screen.getByLabelText(/^Reason for change/), { target: { value: 'Conservation report 2026-09.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Object details updated — now version 2.')).toBeInTheDocument();
    expect(within(lanternCard()).getByText('v2')).toBeInTheDocument();

    fireEvent.click(within(lanternCard()).getByRole('button', { name: 'History' }));
    expect(screen.getByRole('dialog', { name: 'Revision history — v2 current' })).toBeInTheDocument();
    expect(screen.getByText('Conservation report 2026-09.')).toBeInTheDocument();

    const editEntry = revisionEntry(2);
    expect(within(editEntry).getByText('Edited')).toBeInTheDocument();
    expect(within(editEntry).getByText('Railway Signal Lantern')).toBeInTheDocument();
    expect(within(editEntry).getByText('Signal Lantern (Conserved)')).toBeInTheDocument();
    expect(restoreFieldButton(editEntry, 'Title')).toBeDisabled();

    const createEntry = revisionEntry(1);
    expect(within(createEntry).getByText('Created')).toBeInTheDocument();
    fireEvent.click(restoreFieldButton(createEntry, 'Title'));

    expect(screen.getByRole('dialog', { name: 'Revision history — v3 current' })).toBeInTheDocument();
    expect(screen.getByText('Title restored from version 1.')).toBeInTheDocument();
    expect(within(revisionEntry(3)).getByText('Field restore')).toBeInTheDocument();
    expect(within(revisionEntry(3)).getByText('Restored Title from version 1.')).toBeInTheDocument();
    expect(within(lanternCard()).getByRole('heading', { name: 'Railway Signal Lantern' })).toBeInTheDocument();
  });

  it('restores a whole earlier version as a new revision', () => {
    renderCollection();

    fireEvent.click(within(lanternCard()).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Signal Lantern (Conserved)' } });
    fireEvent.change(screen.getByLabelText('Dwell time (min)'), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText(/^Reason for change/), { target: { value: 'Gallery pacing update.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    fireEvent.click(within(lanternCard()).getByRole('button', { name: 'History' }));
    const createEntry = revisionEntry(1);
    expect(within(createEntry).getByRole('button', { name: 'Restore this version' })).toBeEnabled();
    expect(within(revisionEntry(2)).getByRole('button', { name: 'Restore this version' })).toBeDisabled();

    fireEvent.click(within(createEntry).getByRole('button', { name: 'Restore this version' }));

    expect(screen.getByRole('dialog', { name: 'Revision history — v3 current' })).toBeInTheDocument();
    expect(within(revisionEntry(3)).getByText('Full restore')).toBeInTheDocument();
    expect(within(revisionEntry(3)).getByText('Restored the full record to version 1.')).toBeInTheDocument();
    const card = lanternCard();
    expect(within(card).getByRole('heading', { name: 'Railway Signal Lantern' })).toBeInTheDocument();
    expect(within(card).getByText('4 min dwell')).toBeInTheDocument();
  });

  it('requires a change reason when saving an existing object', () => {
    renderCollection();
    fireEvent.click(within(lanternCard()).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Untracked Rename' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByText('Record the basis for this change so the history stays auditable.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('workspace commands against concurrent edits', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('rejects a save based on a stale version instead of overwriting newer work', () => {
    const probe: { context: ReturnType<typeof useWorkspace> | null } = { context: null };
    function Probe() {
      probe.context = useWorkspace();
      return null;
    }
    render(<WorkspaceProvider><Probe /></WorkspaceProvider>);

    const lantern = probe.context?.state.artifacts.find((artifact) => artifact.id === 'artifact-lantern');
    expect(lantern).toBeDefined();
    if (!lantern) return;
    const baseDraft = artifactToDraft(lantern);

    let first: ReturnType<ReturnType<typeof useWorkspace>['upsertArtifact']> | undefined;
    act(() => { first = probe.context?.upsertArtifact({ ...baseDraft, title: 'First Save' }, lantern, 'First reason.'); });
    expect(first?.ok).toBe(true);

    let stale: ReturnType<ReturnType<typeof useWorkspace>['upsertArtifact']> | undefined;
    act(() => { stale = probe.context?.upsertArtifact({ ...baseDraft, title: 'Stale Overwrite' }, lantern, 'Stale reason.'); });
    expect(stale?.ok).toBe(false);
    expect(stale?.conflict).toBe(true);
    expect(stale?.message).toContain('version 2');

    const current = probe.context?.state.artifacts.find((artifact) => artifact.id === 'artifact-lantern');
    expect(current?.title).toBe('First Save');
    expect(current?.revision).toBe(2);
  });
});
