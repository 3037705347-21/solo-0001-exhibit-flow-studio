// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceProvider } from '../../state/WorkspaceContext';
import { STORAGE_KEY } from '../../state/persistence';
import { createSeedWorkspace } from '../../state/seed';
import { InsightsPage } from '../insights/InsightsPage';

function renderInsights() {
  return render(<WorkspaceProvider><InsightsPage /></WorkspaceProvider>);
}

async function saveComparison(name: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Save comparison' }));
  fireEvent.change(screen.getByTestId('comparison-name-input'), { target: { value: name } });
  fireEvent.click(screen.getByTestId('save-comparison-confirm'));
}

describe('insights comparison workflow', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it('saves a named record and replays it side by side on the same plan basis', () => {
    renderInsights();
    fireEvent.click(screen.getByRole('button', { name: /^Leisurely/ }));
    fireEvent.change(screen.getByLabelText('Group size'), { target: { value: '14' } });

    saveComparison('Leisurely crowd');
    expect(screen.getByText(/Comparison .Leisurely crowd. saved/)).toBeTruthy();

    const card = screen.getByTestId('comparison-card');
    expect(within(card).getByText('Current basis')).toBeTruthy();

    fireEvent.click(within(card).getByRole('button', { name: 'Replay' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('SAVED OUTCOME — IMMUTABLE')).toBeTruthy();
    expect(within(dialog).getByText('SAME INPUTS ON CURRENT PLAN')).toBeTruthy();
    expect(within(dialog).queryByTestId('replay-stale-notice')).toBeNull();
  });

  it('rejects duplicate names and identical inputs on the same plan version', () => {
    renderInsights();
    saveComparison('Weekend profile');
    expect(screen.getAllByTestId('comparison-card')).toHaveLength(1);

    // Duplicate name with different casing/whitespace.
    fireEvent.click(screen.getByRole('button', { name: 'Save comparison' }));
    fireEvent.change(screen.getByTestId('comparison-name-input'), { target: { value: '  weekend PROFILE ' } });
    fireEvent.click(screen.getByTestId('save-comparison-confirm'));
    expect(screen.getByText('A comparison with this name already exists. Choose another name.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Same inputs, different name.
    fireEvent.click(screen.getByRole('button', { name: 'Save comparison' }));
    fireEvent.change(screen.getByTestId('comparison-name-input'), { target: { value: 'Same inputs' } });
    fireEvent.click(screen.getByTestId('save-comparison-confirm'));
    expect(screen.getByText(/already saved as/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getAllByTestId('comparison-card')).toHaveLength(1);

    // Different inputs produce a second record.
    fireEvent.change(screen.getByLabelText('Group size'), { target: { value: '3' } });
    saveComparison('Small run');
    expect(screen.getAllByTestId('comparison-card')).toHaveLength(2);
  });

  it('marks records basis-changed after the plan changes and keeps the frozen outcome', () => {
    renderInsights();
    fireEvent.change(screen.getByLabelText('Group size'), { target: { value: '7' } });
    saveComparison('Baseline run');
    const frozenOutcome = screen.getByTestId('comparison-card').querySelector('.comparison-outcomes')?.textContent;
    expect(frozenOutcome).toBeTruthy();

    // Simulate a plan change (remove a placement) persisted to storage, then a fresh reload.
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    stored.zones = stored.zones.map((zone: { id: string; artifactIds: string[] }) =>
      zone.id === 'zone-arrival' ? { ...zone, artifactIds: [] } : zone,
    );
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    cleanup();
    renderInsights();

    const card = screen.getByTestId('comparison-card');
    expect(within(card).getByText('Basis changed')).toBeTruthy();
    expect(card.querySelector('.comparison-outcomes')?.textContent).toBe(frozenOutcome);

    fireEvent.click(within(card).getByRole('button', { name: 'Replay' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('replay-stale-notice')).toBeTruthy();
    expect(within(dialog).getByText('The plan changed since this comparison was saved.')).toBeTruthy();
  });

  it('requires confirmation to delete and keeps records across a reload', () => {
    renderInsights();
    saveComparison('Persistent run');
    expect(screen.getAllByTestId('comparison-card')).toHaveLength(1);

    // Reload from persistence.
    cleanup();
    renderInsights();
    expect(screen.getAllByTestId('comparison-card')).toHaveLength(1);

    // Cancel keeps the record.
    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
    fireEvent.click(screen.getByTestId('replay-delete'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getAllByTestId('comparison-card')).toHaveLength(1);

    // Confirm removes it, persistently.
    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
    fireEvent.click(screen.getByTestId('replay-delete'));
    fireEvent.click(screen.getByTestId('confirm-delete'));
    expect(screen.getByText('No comparisons saved yet')).toBeTruthy();

    cleanup();
    renderInsights();
    expect(screen.getByText('No comparisons saved yet')).toBeTruthy();
  });

  it('persists records created against the seed workspace through a real storage round trip', () => {
    renderInsights();
    saveComparison('Round trip');
    const storedState = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
    expect(storedState.scenarioRecords).toHaveLength(1);
    expect(storedState.scenarioRecords[0].name).toBe('Round trip');
    expect(storedState.scenarioRecords[0].projection.recommendations.length).toBeGreaterThan(0);
    expect(storedState.scenarioRecords[0].planBasis.artifactCount).toBe(createSeedWorkspace().artifacts.length);
  });
});
