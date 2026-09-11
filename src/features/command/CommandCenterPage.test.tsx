import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandCenterPage } from './CommandCenterPage';
import { STORAGE_KEY } from '../../state/persistence';
import { WorkspaceProvider, useWorkspace } from '../../state/WorkspaceContext';

afterEach(() => cleanup());

function renderCommandCenter() {
  const latest: { current?: ReturnType<typeof useWorkspace> } = {};
  function Probe() {
    latest.current = useWorkspace();
    return null;
  }
  render(
    <MemoryRouter>
      <WorkspaceProvider>
        <Probe />
        <CommandCenterPage />
      </WorkspaceProvider>
    </MemoryRouter>,
  );
  return new Proxy({} as ReturnType<typeof useWorkspace>, {
    get(_target, property: keyof ReturnType<typeof useWorkspace>) {
      const value = latest.current?.[property];
      return typeof value === 'function' ? (...args: unknown[]) => (value as (...a: unknown[]) => unknown).apply(latest.current, args) : value;
    },
  });
}

describe('CommandCenterPage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders project identity and the shared engine figures', () => {
    renderCommandCenter();
    expect(screen.getByRole('heading', { level: 1, name: 'Afterlight: Material Memory' })).toBeTruthy();
    expect(screen.getByText('North Hall / Gallery 3')).toBeTruthy();
    expect(screen.getByTestId('command-score').textContent).toBe('70');
    expect(screen.getByText('7/8', { exact: true })).toBeTruthy();
  });

  it('ranks the critical finding first and links every risk to a source page', () => {
    renderCommandCenter();
    const cards = screen.getAllByTestId('risk-card');
    expect(cards[0].getAttribute('href')).toBe('/review?issue=issue-audio-transcript');
    expect(cards[0].getAttribute('data-level')).toBe('critical');
    for (const card of cards) {
      const href = card.getAttribute('href') ?? '';
      expect(href).toMatch(/^\/(collection|journey|review|insights)(\?|$)/);
    }
  });

  it('reflects state changes made through the public commands', async () => {
    const commands = renderCommandCenter();
    // Each command callback closes over the render's state, so dispatch them
    // in separate act() ticks — the same cadence as real click sequences.
    await act(async () => { commands.transitionReviewIssue('issue-audio-transcript', 'in-progress'); });
    await act(async () => { commands.transitionReviewIssue('issue-audio-transcript', 'resolved'); });
    await act(async () => { commands.transitionReviewIssue('issue-entry-copy', 'in-progress'); });
    await act(async () => { commands.transitionReviewIssue('issue-entry-copy', 'resolved'); });
    await act(async () => { commands.checkReadiness(); });
    await waitFor(() => expect(screen.getByTestId('command-score').textContent).toBe('94'));
    expect(screen.getByTestId('risk-count').textContent).not.toContain('All clear');

    await act(async () => { commands.assignArtifact('artifact-gloves', 'zone-arrival'); });
    await waitFor(() => expect(screen.getByText('8/8', { exact: true })).toBeTruthy());
    await act(async () => { commands.checkReadiness(); });
    await waitFor(() => expect(screen.getByTestId('command-score').textContent).toBe('100'));
    expect(screen.getByText('8/8', { exact: true })).toBeTruthy();
    expect(screen.getByTestId('risk-count').textContent).toContain('All clear');
    expect(within(screen.getByTestId('last-check')).getByText(/Passed/)).toBeTruthy();
  });

  it('renders an explicit empty state instead of misleading numbers', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      project: { id: 'p', title: 'Blank Gallery', venue: 'Venue TBD', audience: '', openingDate: '', stage: 'draft' },
      artifacts: [],
      zones: [],
      issues: [],
      preferences: { pace: 'balanced', accessibilityPriority: 0, groupSize: 1 },
    }));
    renderCommandCenter();
    expect(screen.getByRole('heading', { name: 'This workspace has no project content yet' })).toBeTruthy();
    expect(screen.getByTestId('command-score').textContent).toBe('—');
    expect(screen.getByText('Venue TBD')).toBeTruthy();
  });
});
