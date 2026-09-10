import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSeedWorkspace } from './seed';
import { ACTIVITY_HISTORY_KEY } from './activityHistory';
import { STORAGE_KEY } from './persistence';
import { WorkspaceProvider, useWorkspace } from './WorkspaceContext';
import type { WorkspaceContextValue } from './WorkspaceContext';
import type { ArtifactDraft, IssueDraft } from '../domain/models';

let captured: WorkspaceContextValue;

function Harness() {
  captured = useWorkspace();
  return null;
}

function renderProvider() {
  return render(<WorkspaceProvider><Harness /></WorkspaceProvider>);
}

const validDraft: ArtifactDraft = {
  accessionId: 'AF-2031-007',
  title: 'Integration Plaque',
  maker: 'Test Studio',
  yearLabel: '2031',
  medium: 'Enamel',
  origin: 'Lab',
  summary: 'A plaque used to verify provider-level history recording end to end.',
  width: '9',
  height: '11',
  depth: '2',
  dwellMinutes: '3',
  narrativeRole: 'context',
  sensitivity: 'standard',
  accessibilityNeed: 'none',
  isKeyObject: false,
  tags: '',
  color: '#2f7c75',
};

function issueDraft(title: string): IssueDraft {
  return {
    title,
    description: 'Enough context to satisfy the sixteen character minimum rule.',
    severity: 'warning',
    owner: 'Audit Bot',
    zoneId: '',
    artifactId: '',
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('WorkspaceProvider operation history', () => {
  it('records accepted commands immediately and rejects invalid ones without entries', async () => {
    renderProvider();
    expect(captured.history).toEqual([]);

    await act(async () => {
      const result = captured.upsertArtifact({ ...validDraft, title: '' });
      expect(result.ok).toBe(false);
    });
    expect(captured.history).toHaveLength(0);

    await act(async () => {
      expect(captured.upsertArtifact(validDraft).ok).toBe(true);
    });
    expect(captured.history).toHaveLength(1);
    expect(captured.history[0].summary).toContain('Added object “Integration Plaque” (AF-2031-007)');
    expect(captured.history[0].source).toBe('Collection');

    // Boundary reorders (no sequence change) log nothing.
    const [firstZone] = createSeedWorkspace().zones;
    await act(async () => {
      expect(captured.reorderArtifact(firstZone.id, firstZone.artifactIds[0], -1).ok).toBe(true);
    });
    expect(captured.history).toHaveLength(1);

    // A real placement logs with journey metadata.
    await act(async () => {
      expect(captured.assignArtifact('artifact-gloves', 'zone-arrival').ok).toBe(true);
    });
    expect(captured.history).toHaveLength(2);
    expect(captured.history[1].category).toBe('journey');
    expect(captured.history[1].summary).toContain('Placed “Conservator’s Gloves”');
  });

  it('keeps history separate from business state, including across a sample reset', async () => {
    const view = renderProvider();

    await act(async () => {
      expect(captured.upsertArtifact(validDraft).ok).toBe(true);
    });
    expect(captured.state.artifacts.some((artifact) => artifact.title === 'Integration Plaque')).toBe(true);

    await act(async () => {
      captured.resetWorkspace();
    });
    const seed = createSeedWorkspace();
    expect(captured.state.project.title).toBe(seed.project.title);
    expect(captured.state.artifacts.some((artifact) => artifact.title === 'Integration Plaque')).toBe(false);
    // Reset is recorded, not wiped: add + reset.
    expect(captured.history).toHaveLength(2);
    expect(captured.history[1].summary).toBe('Reset workspace to the sample plan');

    // The two documents live under different storage keys.
    const workspaceDoc = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(JSON.stringify(workspaceDoc)).not.toContain('event-');
    expect(JSON.stringify(workspaceDoc)).not.toContain('Integration Plaque');
    const historyDoc = JSON.parse(localStorage.getItem(ACTIVITY_HISTORY_KEY) ?? '[]');
    expect(historyDoc).toHaveLength(2);

    // A freshly mounted provider restores history but starts from seed business state.
    view.unmount();
    renderProvider();
    expect(captured.history).toHaveLength(2);
    expect(captured.state.artifacts.map((artifact) => artifact.id)).toEqual(seed.artifacts.map((artifact) => artifact.id));
  });

  it('caps history at 100 entries while business commands keep working', async () => {
    renderProvider();
    await act(async () => {
      for (let index = 0; index < 105; index += 1) {
        const result = captured.addIssue(issueDraft(`Bulk finding ${index}`));
        expect(result.ok).toBe(true);
      }
    });
    expect(captured.history).toHaveLength(100);
    expect(captured.history[0].summary).toContain('Bulk finding 5');
    expect(captured.history[99].summary).toContain('Bulk finding 104');
    // Business state was not truncated by the log cap.
    expect(captured.state.issues.filter((issue) => issue.title.startsWith('Bulk finding'))).toHaveLength(105);
  });

  it('persists each kind of command with category metadata and restores after remount', async () => {
    const view = renderProvider();
    await act(async () => {
      captured.updatePreferences({ pace: 'leisurely', accessibilityPriority: 40, groupSize: 9 });
      captured.checkReadiness();
    });
    const categories = captured.history.map((entry) => entry.category);
    expect(categories).toContain('preferences');
    expect(categories).toContain('readiness');

    view.unmount();
    renderProvider();
    expect(captured.history).toHaveLength(2);
    expect(captured.history.map((entry) => entry.summary).join(' ')).toContain('Leisurely pace');
  });
});
