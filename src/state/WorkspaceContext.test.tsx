import { cleanup, render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ArtifactDraft } from '../domain/models';
import { STORAGE_KEY } from './persistence';
import { WorkspaceProvider, useWorkspace } from './WorkspaceContext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let context: ReturnType<typeof useWorkspace> | null = null;

function Probe() {
  const workspace = useWorkspace();
  context = workspace;
  return (
    <div>
      <span data-testid="title">{workspace.state.project.title}</span>
      <span data-testid="artifacts">{workspace.state.artifacts.length}</span>
      {workspace.recoveryNotice ? <span data-testid="notice">{workspace.recoveryNotice.message}</span> : null}
    </div>
  );
}

const draft: ArtifactDraft = {
  accessionId: 'af-2099-001',
  title: 'Smoke Test Object',
  maker: 'Test Maker',
  yearLabel: '2099',
  medium: 'Steel',
  origin: 'Lab',
  summary: 'A smoke-test object with enough summary length.',
  width: '10',
  height: '10',
  depth: '10',
  dwellMinutes: '5',
  narrativeRole: 'context',
  sensitivity: 'standard',
  accessibilityNeed: 'none',
  isKeyObject: false,
  tags: '',
  color: '#123456',
};

function mount() {
  return render(<WorkspaceProvider><Probe /></WorkspaceProvider>);
}

describe('WorkspaceProvider persistence', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); context = null; });

  it('persists commands across remounts and stays silent on a clean startup', () => {
    const first = mount();
    expect(screen.getByTestId('title').textContent).toBe('Afterlight: Material Memory');
    expect(screen.getByTestId('artifacts').textContent).toBe('8');

    act(() => {
      const result = context!.upsertArtifact(draft);
      expect(result.ok).toBe(true);
    });
    expect(screen.getByTestId('artifacts').textContent).toBe('9');
    first.unmount();

    mount();
    expect(screen.getByTestId('artifacts').textContent).toBe('9');
    expect(screen.queryByTestId('notice')).toBeNull();
  });

  it('recovers from the mirrored checkpoint and says so when one copy is unreadable', () => {
    const first = mount();
    act(() => { context!.upsertArtifact(draft); });
    first.unmount();

    // A write to one checkpoint slot was interrupted; the mirror still verifies.
    localStorage.setItem(STORAGE_KEY, localStorage.getItem(STORAGE_KEY)!.slice(0, 60));

    mount();
    expect(screen.getByTestId('artifacts').textContent).toBe('9');
    expect(screen.getByTestId('notice').textContent).toContain('unreadable');
  });
});
