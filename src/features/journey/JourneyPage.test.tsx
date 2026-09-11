import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { JourneyPage } from './JourneyPage';
import { WorkspaceProvider } from '../../state/WorkspaceContext';
import { STORAGE_KEY } from '../../state/persistence';
import { createSeedWorkspace } from '../../state/seed';
import { getUnplacedArtifacts } from '../../domain/journeyAnalysis';

function renderPage() {
  return render(
    <WorkspaceProvider>
      <JourneyPage />
    </WorkspaceProvider>,
  );
}

function queue(): HTMLElement {
  return screen.getByText('Object queue').closest('aside')!;
}

function laneFor(zoneName: string): HTMLElement {
  return screen.getByRole('heading', { name: zoneName }).closest('article')!;
}

function placementNamesIn(lane: HTMLElement): string[] {
  return within(lane)
    .getAllByRole('button', { name: /^(move|remove) /i })
    .map((button) => button.getAttribute('aria-label') ?? '');
}

describe('journey page placement moves', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(createSeedWorkspace()));
  });

  it('moves an unplaced object into a zone without duplicating it across zones', () => {
    renderPage();
    const seed = createSeedWorkspace();
    const [unplaced] = getUnplacedArtifacts(seed.artifacts, seed.zones);

    // Select the object in the unplaced queue...
    fireEvent.click(within(queue()).getByRole('button', { name: new RegExp(unplaced.title) }));
    // ...then drop it in the arrival zone.
    fireEvent.click(within(laneFor('Arrival / A Light Carried')).getByRole('button', { name: new RegExp(`place .*${unplaced.title}`, 'i') }));

    const arrival = laneFor('Arrival / A Light Carried');
    expect(within(arrival).getByText(unplaced.title)).toBeInTheDocument();
    // The queue no longer offers this object.
    expect(within(queue()).queryByRole('button', { name: new RegExp(unplaced.title) })).not.toBeInTheDocument();
  });

  it('moves an object from one zone to another: removed from the source, appended in the target, no duplicates', () => {
    renderPage();

    const sourceBefore = laneFor('Arrival / A Light Carried');
    expect(within(sourceBefore).getByText('Railway Signal Lantern')).toBeInTheDocument();

    // The lantern is currently placed; removing it first returns it to the queue.
    fireEvent.click(within(sourceBefore).getByRole('button', { name: /remove railway signal lantern/i }));
    fireEvent.click(within(queue()).getByRole('button', { name: /railway signal lantern/i }));

    const target = laneFor('Afterlives');
    fireEvent.click(within(target).getByRole('button', { name: /place .*railway signal lantern/i }));

    const sourceAfter = laneFor('Arrival / A Light Carried');
    expect(within(sourceAfter).queryByText('Railway Signal Lantern')).not.toBeInTheDocument();

    const targetAfter = laneFor('Afterlives');
    expect(within(targetAfter).getByText('Railway Signal Lantern')).toBeInTheDocument();
    // Order inside the target: pre-existing objects first, moved object appended last.
    const labels = placementNamesIn(targetAfter);
    expect(labels[labels.length - 1]).toMatch(/railway signal lantern/i);

    // Exactly one lane renders a remove control for the lantern.
    const removeButtons = screen.getAllByRole('button', { name: /remove railway signal lantern/i });
    expect(removeButtons).toHaveLength(1);
  });
});
