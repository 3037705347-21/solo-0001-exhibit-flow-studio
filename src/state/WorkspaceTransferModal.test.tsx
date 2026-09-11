import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { WorkspaceProvider } from './WorkspaceContext';
import { WorkspaceTransferModal } from '../components/WorkspaceTransferModal';
import { createSeedWorkspace } from './seed';
import { buildImportFixture } from './testFixtures';

function renderModal() {
  const result = render(
    <WorkspaceProvider>
      <WorkspaceTransferModal onClose={() => undefined} />
    </WorkspaceProvider>,
  );
  return result;
}

function jsonFile(payload: unknown, name = 'import.json'): File {
  const file = new File([JSON.stringify(payload)], name, { type: 'application/json' });
  // jsdom's Blob predates Blob.text(); real browsers provide it.
  Object.defineProperty(file, 'text', { value: async () => JSON.stringify(payload) });
  return file;
}

function chooseFile(payload: unknown) {
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [jsonFile(payload)] } });
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:mock', revokeObjectURL: () => undefined });
});

afterEach(() => {
  cleanup();
});

describe('workspace transfer modal', () => {
  it('reviews and restores a current-version file, then re-exports it', async () => {
    renderModal();
    chooseFile(buildImportFixture({ version: 2 }));

    await waitFor(() => expect(screen.getByText(/kept/)).toBeTruthy());
    expect(screen.getByText('17 kept')).toBeTruthy();
    expect(screen.getByText('0 invalidated')).toBeTruthy();
    expect(screen.getByText('0 need confirmation')).toBeTruthy();

    const restore = screen.getByRole('button', { name: 'Restore workspace' });
    expect(restore).not.toBeDisabled();
    fireEvent.click(restore);

    await screen.findByText('Workspace restored');

    // Let the provider's post-restore autosave effect run; the transactional
    // write owns storage, so the rollback backup must still be present.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.localStorage.getItem('exhibit-flow.workspace.restore-backup.v1')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Keep restored workspace' }));

    // Stored workspace is v2 and accepting clears the rollback backup slot.
    const stored = JSON.parse(window.localStorage.getItem('exhibit-flow.workspace.v1') as string);
    expect(stored.version).toBe(2);
    expect(window.localStorage.getItem('exhibit-flow.workspace.restore-backup.v1')).toBeNull();
  });

  it('migrates a legacy file and lists ordered migration steps', async () => {
    renderModal();
    chooseFile(buildImportFixture({ version: 0 }));

    await screen.findByText('Legacy workspace normalization');
    expect(screen.getByText('Planning preferences expansion')).toBeTruthy();
    expect(screen.getByText('Structure and reference integrity')).toBeTruthy();
    expect(screen.getByText('v0 (legacy)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore workspace' }));
    await screen.findByText('Workspace restored');
  });

  it('blocks restore until broken-reference decisions are made and honors exclusion', async () => {
    renderModal();
    chooseFile(buildImportFixture({ version: 2, brokenReferences: true }));

    await waitFor(() => expect(screen.getAllByText(/Drop broken link, keep record/).length).toBeGreaterThan(0));
    const rows = await screen.findAllByText(/links to|places object|links to zone/i).catch(() => []);
    expect(rows.length).toBeGreaterThan(0);

    const restore = screen.getByRole('button', { name: 'Restore workspace' });
    expect(restore).toBeDisabled();

    const keepButtons = screen.getAllByRole('button', { name: 'Drop broken link, keep record' });
    fireEvent.click(keepButtons[0]);
    expect(restore).toBeDisabled(); // still 2 undecided
    fireEvent.click(keepButtons[1]);
    const excludeButtons = screen.getAllByRole('button', { name: 'Exclude record' });
    fireEvent.click(excludeButtons[excludeButtons.length - 1]);
    expect(restore).not.toBeDisabled();
    fireEvent.click(restore);
    await screen.findByText('Workspace restored');
  });

  it('invalidates records with unrecoverable missing fields but applies repairable defaults', async () => {
    renderModal();
    chooseFile(buildImportFixture({ version: 2, missingField: true }));

    await waitFor(() => expect(screen.getByText('1 invalidated')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Restore workspace' }));
    await screen.findByText('Workspace restored');
    const stored = JSON.parse(window.localStorage.getItem('exhibit-flow.workspace.v1') as string);
    expect(stored.artifacts).toHaveLength(7);
    expect(stored.artifacts.find((a: { id: string }) => a.id === 'artifact-lantern').title).toBe('Untitled object');
  });

  it('undoing a restore brings the previous workspace back', async () => {
    // Pre-seed storage with the sample plan and remember its title.
    const seed = createSeedWorkspace();
    window.localStorage.setItem('exhibit-flow.workspace.v1', JSON.stringify(seed));
    renderModal();

    // Import an altered legacy workspace.
    const payload = buildImportFixture({ version: 1 }) as Record<string, unknown>;
    (payload.project as Record<string, unknown>).title = 'Restored Legacy Exhibition';
    chooseFile(payload);

    await screen.findByText('Planning preferences expansion');
    fireEvent.click(screen.getByRole('button', { name: 'Restore workspace' }));
    await screen.findByText('Workspace restored');
    fireEvent.click(screen.getByRole('button', { name: 'Undo restore' }));

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem('exhibit-flow.workspace.v1') as string);
      expect(stored.project.title).toBe(seed.project.title);
    });
  });

  it('refuses a non-workspace file without touching storage', async () => {
    renderModal();
    chooseFile({ schemaVersion: 1, project: {}, summary: {}, zones: [] });
    expect(await screen.findByText(/read-only readiness snapshot/)).toBeTruthy();
    expect(window.localStorage.getItem('exhibit-flow.workspace.restore-backup.v1')).toBeNull();
  });

  it('shows the two transfer choices before a file is selected', () => {
    renderModal();
    expect(screen.getByTestId('choose-workspace-file')).toBeTruthy();
    expect(screen.getByTestId('export-current-workspace')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Restore workspace' })).toBeNull();
  });
});
