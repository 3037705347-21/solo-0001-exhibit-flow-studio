import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { CollectionPage } from './CollectionPage';
import { WorkspaceProvider } from '../../state/WorkspaceContext';
import { STORAGE_KEY } from '../../state/persistence';
import { createSeedWorkspace } from '../../state/seed';
import type { ArtifactDraft } from '../../domain/models';
import { emptyArtifactDraft } from '../../domain/artifactValidation';

function renderPage() {
  return render(
    <WorkspaceProvider>
      <CollectionPage />
    </WorkspaceProvider>,
  );
}

function openEditor() {
  fireEvent.click(screen.getByRole('button', { name: /add object/i }));
  return screen.getByRole('dialog', { name: /add to collection/i });
}

function fillDraft(editor: HTMLElement, overrides: Partial<ArtifactDraft>) {
  const draft = { ...emptyArtifactDraft, ...overrides };
  const field = (label: RegExp) => within(editor).getByLabelText(label) as HTMLInputElement;
  fireEvent.change(field(/accession id/i), { target: { value: draft.accessionId } });
  fireEvent.change(field(/^title$/i), { target: { value: draft.title } });
  fireEvent.change(field(/maker/i), { target: { value: draft.maker } });
  fireEvent.change(field(/^medium$/i), { target: { value: draft.medium } });
  fireEvent.change(field(/object summary/i), { target: { value: draft.summary } });
  fireEvent.change(field(/width/i), { target: { value: draft.width } });
  fireEvent.change(field(/height/i), { target: { value: draft.height } });
  fireEvent.change(field(/depth/i), { target: { value: draft.depth } });
  fireEvent.change(field(/dwell time/i), { target: { value: draft.dwellMinutes } });
}

const validDraft: ArtifactDraft = {
  ...emptyArtifactDraft,
  accessionId: 'AF-2027-900',
  title: 'Gallery Direction Plaque',
  maker: 'Wayfinding Workshop',
  medium: 'Cast bronze',
  summary: 'A directional plaque explaining visitor flow at the gallery threshold.',
  width: '12',
  height: '18',
  depth: '2',
  dwellMinutes: '4',
};

describe('collection page object entry', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(createSeedWorkspace()));
  });

  it('rejects a duplicate accession id and keeps the editor open with a field message', () => {
    renderPage();
    const editor = openEditor();

    fillDraft(editor, { ...validDraft, accessionId: 'af-1908-014' });
    fireEvent.click(within(editor).getByRole('button', { name: /add object/i }));

    expect(within(editor).getByText(/already in the collection/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Railway Signal Lantern/i).length).toBeGreaterThan(0);
    expect(screen.queryByText('Gallery Direction Plaque')).not.toBeInTheDocument();
  });

  it('rejects an invalid dimension and an overly short summary with field-level messages', () => {
    renderPage();
    const editor = openEditor();

    fillDraft(editor, { ...validDraft, width: '0', summary: 'Too short' });
    fireEvent.click(within(editor).getByRole('button', { name: /add object/i }));

    expect(within(editor).getByText(/width must be greater than zero/i)).toBeInTheDocument();
    expect(within(editor).getByText(/at least 24 characters/i)).toBeInTheDocument();
    expect(screen.queryByText('Gallery Direction Plaque')).not.toBeInTheDocument();
  });

  it('adds a valid object through the editor and closes the modal', () => {
    renderPage();
    const editor = openEditor();

    fillDraft(editor, validDraft);
    fireEvent.click(within(editor).getByRole('button', { name: /add object/i }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Gallery Direction Plaque')).toBeInTheDocument();
    expect(screen.getByText('AF-2027-900')).toBeInTheDocument();
  });

  it('edits an existing object without creating a second record', () => {
    renderPage();

    const card = screen.getByText('Railway Signal Lantern').closest('article')!;
    fireEvent.click(within(card).getByRole('button', { name: /^edit$/i }));

    const editor = screen.getByRole('dialog', { name: /update object record/i });
    const titleField = within(editor).getByLabelText(/^title$/i) as HTMLInputElement;
    fireEvent.change(titleField, { target: { value: 'Railway Signal Lantern (restored)' } });
    fireEvent.click(within(editor).getByRole('button', { name: /save changes/i }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getAllByText(/Railway Signal Lantern/)[0]).toBeInTheDocument();
    expect(screen.getAllByText('AF-1908-014')).toHaveLength(1);
    expect(screen.getByText('Railway Signal Lantern (restored)')).toBeInTheDocument();
  });
});
