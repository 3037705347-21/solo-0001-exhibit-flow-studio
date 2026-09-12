import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkspace, WorkspaceProvider } from '../../state/WorkspaceContext';
import { CollectionPage } from './CollectionPage';

type WorkspaceApi = ReturnType<typeof useWorkspace>;

function renderCollection() {
  let api: WorkspaceApi | null = null;
  function Probe() {
    api = useWorkspace();
    return null;
  }
  render(<WorkspaceProvider><Probe /><CollectionPage /></WorkspaceProvider>);
  return () => {
    if (!api) throw new Error('Workspace probe is not mounted.');
    return api;
  };
}

function openLanternEditor() {
  fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
}

function lantern(api: () => WorkspaceApi) {
  return api().state.artifacts.find((candidate) => candidate.id === 'artifact-lantern');
}

describe('collection quick edit with impact pre-check', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('saves through the impact preview and records the change', () => {
    const api = renderCollection();
    openLanternEditor();
    fireEvent.change(screen.getByLabelText('Dwell time (min)'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review impact' }));

    expect(screen.getByText('ZONES AFFECTED (1)')).toBeInTheDocument();
    expect(screen.getByText('Arrival / A Light Carried')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm save' }));
    expect(lantern(api)?.dwellMinutes).toBe(12);
    expect(api().commandLog).toHaveLength(1);
    expect(api().commandLog[0].details).toContain('Dwell time 4 min → 12 min');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Object details updated.')).toBeInTheDocument();
  });

  it('restores the full draft when returning from the preview and leaves the record untouched on cancel', () => {
    const api = renderCollection();
    openLanternEditor();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Lantern Revised' } });
    fireEvent.change(screen.getByLabelText('Dwell time (min)'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review impact' }));
    expect(screen.getByText('ZONES AFFECTED (1)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back to edit' }));
    expect(screen.getByLabelText('Title')).toHaveValue('Lantern Revised');
    expect(screen.getByLabelText('Dwell time (min)')).toHaveValue(12);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(lantern(api)?.title).toBe('Railway Signal Lantern');
    expect(lantern(api)?.dwellMinutes).toBe(4);
    expect(api().commandLog).toHaveLength(0);
  });

  it('refreshes the preview instead of saving when the plan changes before confirming', () => {
    const api = renderCollection();
    openLanternEditor();
    fireEvent.change(screen.getByLabelText('Dwell time (min)'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review impact' }));

    // The plan changes elsewhere while the preview is open.
    act(() => { api().assignArtifact('artifact-gloves', 'zone-after'); });

    fireEvent.click(screen.getByRole('button', { name: 'Confirm save' }));
    expect(screen.getByText(/plan changed after this impact preview/i)).toBeInTheDocument();
    expect(lantern(api)?.dwellMinutes).toBe(4);
    expect(api().commandLog).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Confirm save' }));
    expect(lantern(api)?.dwellMinutes).toBe(12);
    expect(api().commandLog).toHaveLength(1);
  });

  it('keeps the form open with field errors when validation fails', () => {
    const api = renderCollection();
    openLanternEditor();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review impact' }));

    expect(screen.getByText('Title is required.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm save' })).not.toBeInTheDocument();
    expect(lantern(api)?.dwellMinutes).toBe(4);
    expect(api().commandLog).toHaveLength(0);
  });
});
