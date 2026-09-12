import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STORAGE_KEY } from '../../state/persistence';
import { createSeedWorkspace } from '../../state/seed';
import { WorkspaceProvider } from '../../state/WorkspaceContext';
import { CollectionPage } from './CollectionPage';

const TITLE_ORDER = [
  'Conservator’s Gloves',
  'Dyer’s Sample Book',
  'Kitchen Table Radio',
  'Mended Serving Bowl',
  'Oral History Tape 12',
  'Portable Letterpress',
  'Railway Signal Lantern',
  'Rain Map Quilt',
];

function renderPage() {
  return render(<WorkspaceProvider><CollectionPage /></WorkspaceProvider>);
}

function cardTitles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.artifact-card h3')).map((node) => node.textContent ?? '');
}

describe('CollectionPage sorting', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  it('opens in added order and sorts deterministically by title', () => {
    const { container } = renderPage();
    expect(cardTitles(container)[0]).toBe('Railway Signal Lantern');

    fireEvent.change(screen.getByLabelText('Sort objects by'), { target: { value: 'title' } });
    expect(cardTitles(container)).toEqual(TITLE_ORDER);

    fireEvent.click(screen.getByLabelText('Sort direction: ascending'));
    expect(screen.getByLabelText('Sort direction: descending')).toBeInTheDocument();
    expect(cardTitles(container)[0]).toBe('Rain Map Quilt');
  });

  it('keeps the order stable while search and role filters toggle', () => {
    const { container } = renderPage();
    fireEvent.change(screen.getByLabelText('Sort objects by'), { target: { value: 'title' } });

    fireEvent.change(screen.getByLabelText('Search collection'), { target: { value: 'radio' } });
    expect(cardTitles(container)).toEqual(['Kitchen Table Radio']);
    fireEvent.change(screen.getByLabelText('Search collection'), { target: { value: '' } });
    expect(cardTitles(container)).toEqual(TITLE_ORDER);

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.change(screen.getByLabelText('Narrative role'), { target: { value: 'reflection' } });
    expect(cardTitles(container)).toEqual(['Conservator’s Gloves', 'Mended Serving Bowl', 'Oral History Tape 12']);

    fireEvent.change(screen.getByLabelText('Sensitivity'), { target: { value: 'fragile' } });
    expect(cardTitles(container)).toEqual(['Mended Serving Bowl']);

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(cardTitles(container)).toEqual(TITLE_ORDER);
  });

  it('restores the sort rule after a refresh and keeps dwell ties in title order', () => {
    const first = renderPage();
    fireEvent.change(screen.getByLabelText('Sort objects by'), { target: { value: 'dwellMinutes' } });
    expect(screen.getByLabelText('Sort objects by')).toHaveValue('dwellMinutes');
    first.unmount();

    const second = renderPage();
    expect(screen.getByLabelText('Sort objects by')).toHaveValue('dwellMinutes');
    const titles = cardTitles(second.container);
    // Longest dwell first by default; the two 6-minute and two 4-minute objects keep title order.
    expect(titles).toEqual([
      'Rain Map Quilt',
      'Portable Letterpress',
      'Dyer’s Sample Book',
      'Oral History Tape 12',
      'Kitchen Table Radio',
      'Mended Serving Bowl',
      'Railway Signal Lantern',
      'Conservator’s Gloves',
    ]);
  });

  it('never rewrites the stored artifact order or timestamps while sorting', () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Sort objects by'), { target: { value: 'title' } });
    fireEvent.click(screen.getByLabelText('Sort direction: ascending'));

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as ReturnType<typeof createSeedWorkspace>;
    const seed = createSeedWorkspace();
    expect(stored.artifacts.map((artifact) => artifact.id)).toEqual(seed.artifacts.map((artifact) => artifact.id));
    expect(stored.artifacts.map((artifact) => artifact.updatedAt)).toEqual(seed.artifacts.map((artifact) => artifact.updatedAt));
  });
});
