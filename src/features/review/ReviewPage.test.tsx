import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ReviewPage } from './ReviewPage';
import { WorkspaceProvider } from '../../state/WorkspaceContext';
import { REVIEW_UI_KEY, STORAGE_KEY } from '../../state/persistence';
import { createSeedWorkspace } from '../../state/seed';

function renderPage() {
  return render(
    <WorkspaceProvider>
      <ReviewPage />
    </WorkspaceProvider>,
  );
}

describe('review page', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(createSeedWorkspace()));
  });

  it('stays usable when the saved zone preference points at a zone that no longer exists', () => {
    localStorage.setItem(
      REVIEW_UI_KEY,
      JSON.stringify({ zoneId: 'zone-demolished', status: 'all' }),
    );

    renderPage();

    // No zone matches, so the select falls back to the overview and every
    // finding remains visible instead of the page rendering an empty scope.
    const zoneSelect = screen.getByLabelText(/exhibition zone/i) as HTMLSelectElement;
    expect(zoneSelect.value).toBe('');
    expect(screen.getByText('Add transcript beside oral history station')).toBeInTheDocument();
    expect(screen.getByText('Reduce entry panel copy')).toBeInTheDocument();
  });

  it('falls back to the all-status filter when the saved status is not a valid filter', () => {
    localStorage.setItem(
      REVIEW_UI_KEY,
      JSON.stringify({ zoneId: '', status: 'archived' }),
    );

    renderPage();

    const allButton = screen.getByRole('button', { name: /^all/i });
    expect(allButton).toHaveClass('selected');
    // Open and resolved findings are both shown under the recovered "all" filter.
    expect(screen.getByText('Reduce entry panel copy')).toBeInTheDocument();
    expect(screen.getByText('Confirm quilt lux rotation')).toBeInTheDocument();
  });

  it('walks an open finding through its legal transition from the page', () => {
    renderPage();

    const row = screen.getByText('Reduce entry panel copy').closest('article')!;
    expect(within(row).getByText('Open')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: /start work/i }));

    expect(within(row).getByText('In Progress')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /resolve/i })).toBeInTheDocument();
  });
});
