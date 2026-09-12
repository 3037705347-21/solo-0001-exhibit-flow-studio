import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceState } from '../../domain/models';
import { STORAGE_KEY } from '../../state/persistence';
import { createSeedWorkspace } from '../../state/seed';
import { WorkspaceProvider } from '../../state/WorkspaceContext';
import { JourneyPage } from './JourneyPage';

function renderJourney() {
  return render(
    <WorkspaceProvider>
      <JourneyPage />
    </WorkspaceProvider>,
  );
}

function zoneLane(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { name });
  const lane = heading.closest('.zone-lane');
  if (!lane) throw new Error(`Zone lane not found for ${name}`);
  return lane as HTMLElement;
}

function placedTitles(lane: HTMLElement): string[] {
  return Array.from(lane.querySelectorAll('.placement-item .placement-info strong')).map((element) => element.textContent ?? '');
}

function moveButton(lane: HTMLElement, title: string, direction: 'up' | 'down'): HTMLElement {
  return within(lane).getByRole('button', { name: `Move ${title} ${direction}` });
}

/** Rewrite persisted state the way another tab would, without firing a storage event. */
function writeExternalState(mutate: (state: WorkspaceState) => WorkspaceState): void {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) throw new Error('Nothing persisted yet');
  const next = mutate(JSON.parse(raw) as WorkspaceState);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

function withZoneOrder(state: WorkspaceState, zoneId: string, artifactIds: string[]): WorkspaceState {
  return {
    ...state,
    zones: state.zones.map((zone) => (zone.id === zoneId
      ? { ...zone, artifactIds, version: zone.version + 1 }
      : zone)),
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('local consecutive reorders', () => {
  it('chains rapid consecutive moves, each based on the latest committed order', () => {
    renderJourney();
    const lane = zoneLane('Patterns of Work');
    expect(placedTitles(lane)).toEqual(['Dyer’s Sample Book', 'Kitchen Table Radio']);

    fireEvent.click(moveButton(lane, 'Kitchen Table Radio', 'up'));
    expect(placedTitles(lane)).toEqual(['Kitchen Table Radio', 'Dyer’s Sample Book']);

    fireEvent.click(moveButton(lane, 'Kitchen Table Radio', 'down'));
    fireEvent.click(moveButton(lane, 'Kitchen Table Radio', 'up'));
    expect(placedTitles(lane)).toEqual(['Kitchen Table Radio', 'Dyer’s Sample Book']);

    // No object was lost or duplicated along the way.
    expect(lane.querySelectorAll('.placement-item')).toHaveLength(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('disables boundary moves so first and last objects cannot leave the zone', () => {
    renderJourney();
    const lane = zoneLane('Patterns of Work');
    expect(moveButton(lane, 'Dyer’s Sample Book', 'up')).toBeDisabled();
    expect(moveButton(lane, 'Kitchen Table Radio', 'down')).toBeDisabled();
    expect(moveButton(lane, 'Dyer’s Sample Book', 'down')).toBeEnabled();
    expect(moveButton(lane, 'Kitchen Table Radio', 'up')).toBeEnabled();
  });

  it('reorders through drag and drop using the same versioned pipeline', () => {
    renderJourney();
    const lane = zoneLane('Patterns of Work');
    const items = lane.querySelectorAll('.placement-item');
    const list = lane.querySelector('.placement-list');
    if (!list) throw new Error('placement list missing');
    const dataTransfer = {
      setData: () => undefined,
      getData: () => 'artifact-sample-book',
      effectAllowed: '',
      dropEffect: '',
    };
    fireEvent.dragStart(items[0], { dataTransfer });
    fireEvent.dragOver(items[1], { dataTransfer, clientY: 0 });
    fireEvent.drop(list, { dataTransfer });
    expect(placedTitles(lane)).toEqual(['Kitchen Table Radio', 'Dyer’s Sample Book']);
    expect(lane.querySelectorAll('.placement-item')).toHaveLength(2);
  });

  it('undoes and redoes reorders, and clears redo after a new move', () => {
    renderJourney();
    const lane = zoneLane('Patterns of Work');
    const undoButton = screen.getByRole('button', { name: 'Undo last change' });
    const redoButton = screen.getByRole('button', { name: 'Redo change' });
    expect(undoButton).toBeDisabled();
    expect(redoButton).toBeDisabled();

    fireEvent.click(moveButton(lane, 'Kitchen Table Radio', 'up'));
    expect(placedTitles(lane)).toEqual(['Kitchen Table Radio', 'Dyer’s Sample Book']);
    expect(undoButton).toBeEnabled();

    fireEvent.click(undoButton);
    expect(placedTitles(lane)).toEqual(['Dyer’s Sample Book', 'Kitchen Table Radio']);
    expect(redoButton).toBeEnabled();

    fireEvent.click(redoButton);
    expect(placedTitles(lane)).toEqual(['Kitchen Table Radio', 'Dyer’s Sample Book']);

    fireEvent.click(undoButton);
    fireEvent.click(moveButton(lane, 'Kitchen Table Radio', 'up'));
    expect(redoButton).toBeDisabled();
    expect(lane.querySelectorAll('.placement-item')).toHaveLength(2);
  });

  it('supports keyboard undo with ctrl+z', () => {
    renderJourney();
    const lane = zoneLane('Patterns of Work');
    fireEvent.click(moveButton(lane, 'Kitchen Table Radio', 'up'));
    expect(placedTitles(lane)).toEqual(['Kitchen Table Radio', 'Dyer’s Sample Book']);
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(placedTitles(lane)).toEqual(['Dyer’s Sample Book', 'Kitchen Table Radio']);
  });
});

describe('external order changes', () => {
  it('adopts orders written by another tab via the storage event', () => {
    renderJourney();
    const lane = zoneLane('Patterns of Work');
    writeExternalState((state) => withZoneOrder(state, 'zone-patterns', ['artifact-radio', 'artifact-sample-book']));
    fireEvent(window, new StorageEvent('storage', { key: STORAGE_KEY, newValue: localStorage.getItem(STORAGE_KEY) }));
    expect(placedTitles(lane)).toEqual(['Kitchen Table Radio', 'Dyer’s Sample Book']);
  });

  it('rebases a stale drag onto the external order and shows the difference', () => {
    // Three-object zone so the external swap and the local move compose.
    const initial = withZoneOrder(
      withZoneOrder(createSeedWorkspace(), 'zone-common', ['artifact-press', 'artifact-quilt', 'artifact-bowl']),
      'zone-after',
      ['artifact-tape'],
    );
    localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
    renderJourney();
    const lane = zoneLane('The Common Thread');
    expect(placedTitles(lane)).toEqual(['Portable Letterpress', 'Rain Map Quilt', 'Mended Serving Bowl']);

    // Another tab swaps the first two objects; this tab has not seen it yet.
    writeExternalState((state) => withZoneOrder(state, 'zone-common', ['artifact-quilt', 'artifact-press', 'artifact-bowl']));

    // The stale drag (quilt to the end) is re-validated before committing.
    fireEvent.click(moveButton(lane, 'Rain Map Quilt', 'down'));

    const toast = screen.getByRole('alert');
    expect(toast).toHaveTextContent('changed in another tab');
    expect(toast).toHaveTextContent('re-applied');
    expect(toast).toHaveTextContent('Rain Map Quilt');

    // External swap preserved, the move replayed on top, nothing lost or duplicated.
    expect(placedTitles(lane)).toEqual(['Portable Letterpress', 'Mended Serving Bowl', 'Rain Map Quilt']);
    expect(lane.querySelectorAll('.placement-item')).toHaveLength(3);
  });

  it('rejects a drag whose object was removed externally and asks for re-confirmation', () => {
    const initial = withZoneOrder(
      withZoneOrder(createSeedWorkspace(), 'zone-common', ['artifact-press', 'artifact-quilt', 'artifact-bowl']),
      'zone-after',
      ['artifact-tape'],
    );
    localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
    renderJourney();
    const lane = zoneLane('The Common Thread');

    // Another tab removes the quilt from the zone entirely.
    writeExternalState((state) => withZoneOrder(state, 'zone-common', ['artifact-press', 'artifact-bowl']));

    fireEvent.click(moveButton(lane, 'Rain Map Quilt', 'down'));

    const toast = screen.getByRole('alert');
    expect(toast).toHaveTextContent('changed in another tab');
    expect(toast).toHaveTextContent('no longer placed');

    // The external removal is not overwritten: the quilt stays out of the zone
    // and reappears in the unplaced queue for re-confirmation.
    expect(placedTitles(lane)).toEqual(['Portable Letterpress', 'Mended Serving Bowl']);
    expect(within(screen.getByText('Object queue').closest('.journey-sidebar') as HTMLElement).getByRole('button', { name: /Rain Map Quilt/ })).toBeInTheDocument();
  });
});

describe('refresh recovery', () => {
  it('restores the reordered zone and its version after a reload', () => {
    const first = renderJourney();
    const lane = zoneLane('Patterns of Work');
    fireEvent.click(moveButton(lane, 'Kitchen Table Radio', 'up'));
    expect(placedTitles(lane)).toEqual(['Kitchen Table Radio', 'Dyer’s Sample Book']);
    first.unmount();

    renderJourney();
    const reloaded = zoneLane('Patterns of Work');
    expect(placedTitles(reloaded)).toEqual(['Kitchen Table Radio', 'Dyer’s Sample Book']);

    // Reorders continue to work on the restored version.
    fireEvent.click(moveButton(reloaded, 'Kitchen Table Radio', 'down'));
    expect(placedTitles(reloaded)).toEqual(['Dyer’s Sample Book', 'Kitchen Table Radio']);
    expect(reloaded.querySelectorAll('.placement-item')).toHaveLength(2);
  });
});
