import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { artifactToDraft } from '../domain/artifactValidation';
import { impactBaseVersion } from '../domain/impactPreview';
import type { Artifact } from '../domain/models';
import { useWorkspace, WorkspaceProvider, type CommitArtifactResult } from './WorkspaceContext';

type WorkspaceApi = ReturnType<typeof useWorkspace>;

function setup() {
  let api: WorkspaceApi | null = null;
  function Probe() {
    api = useWorkspace();
    return null;
  }
  render(<WorkspaceProvider><Probe /></WorkspaceProvider>);
  return () => {
    if (!api) throw new Error('Workspace probe is not mounted.');
    return api;
  };
}

function artifact(api: () => WorkspaceApi, id: string): Artifact {
  const found = api().state.artifacts.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Unknown artifact ${id}`);
  return found;
}

describe('artifact impact pre-check flow', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('saves a confirmed change and appends one traceable record', () => {
    const api = setup();
    const lantern = artifact(api, 'artifact-lantern');
    const draft = { ...artifactToDraft(lantern), dwellMinutes: '12' };

    let preview: ReturnType<WorkspaceApi['previewArtifactChange']> | undefined;
    act(() => { preview = api().previewArtifactChange(draft, lantern); });
    expect(preview?.ok).toBe(true);
    expect(preview?.value?.hasImpact).toBe(true);
    expect(preview?.value?.affectedZones.map((zone) => zone.zoneId)).toEqual(['zone-arrival']);
    expect(api().state.artifacts.find((candidate) => candidate.id === 'artifact-lantern')?.dwellMinutes).toBe(4);

    let commit: CommitArtifactResult | undefined;
    act(() => { commit = api().commitArtifactChange(draft, lantern, preview?.value?.baseVersion ?? ''); });
    expect(commit?.ok).toBe(true);
    expect(api().state.artifacts.find((candidate) => candidate.id === 'artifact-lantern')?.dwellMinutes).toBe(12);

    expect(api().commandLog).toHaveLength(1);
    const entry = api().commandLog[0];
    expect(entry.action).toBe('artifact/upsert');
    expect(entry.actor).toBe('local-user');
    expect(entry.summary).toContain('AF-1908-014');
    expect(entry.details).toContain('Dwell time 4 min → 12 min');
    expect(entry.timestamp).toBeTruthy();
  });

  it('recomputes the preview when the plan changes after the preview was computed', () => {
    const api = setup();
    const lantern = artifact(api, 'artifact-lantern');
    const draft = { ...artifactToDraft(lantern), dwellMinutes: '12' };

    let preview: ReturnType<WorkspaceApi['previewArtifactChange']> | undefined;
    act(() => { preview = api().previewArtifactChange(draft, lantern); });
    const staleVersion = preview?.value?.baseVersion ?? '';

    // The plan moves on after the preview was computed.
    act(() => { api().assignArtifact('artifact-gloves', 'zone-after'); });

    let commit: CommitArtifactResult | undefined;
    act(() => { commit = api().commitArtifactChange(draft, lantern, staleVersion); });
    expect(commit?.ok).toBe(false);
    expect(commit?.stale).toBe(true);
    expect(commit?.preview?.baseVersion).not.toBe(staleVersion);
    expect(commit?.preview?.baseVersion).toBe(impactBaseVersion(api().state));

    // The stale preview was not applied and nothing was recorded.
    expect(artifact(api, 'artifact-lantern').dwellMinutes).toBe(4);
    expect(api().commandLog).toHaveLength(0);

    // Confirming against the refreshed preview saves and records the change.
    let second: CommitArtifactResult | undefined;
    act(() => { second = api().commitArtifactChange(draft, lantern, commit?.preview?.baseVersion ?? ''); });
    expect(second?.ok).toBe(true);
    expect(artifact(api, 'artifact-lantern').dwellMinutes).toBe(12);
    expect(api().commandLog).toHaveLength(1);
  });

  it('recomputes the preview when the object itself changes after the preview was computed', () => {
    const api = setup();
    const lantern = artifact(api, 'artifact-lantern');
    const draft = { ...artifactToDraft(lantern), dwellMinutes: '12' };

    let preview: ReturnType<WorkspaceApi['previewArtifactChange']> | undefined;
    act(() => { preview = api().previewArtifactChange(draft, lantern); });
    const staleVersion = preview?.value?.baseVersion ?? '';

    // The object record is edited elsewhere before the confirm lands.
    act(() => { api().upsertArtifact({ ...artifactToDraft(lantern), maker: 'H. B. Cooke & Sons' }, lantern); });

    let commit: CommitArtifactResult | undefined;
    act(() => { commit = api().commitArtifactChange(draft, lantern, staleVersion); });
    expect(commit?.ok).toBe(false);
    expect(commit?.stale).toBe(true);
    expect(commit?.preview?.baseVersion).toBe(impactBaseVersion(api().state));
    expect(artifact(api, 'artifact-lantern').dwellMinutes).toBe(4);
    expect(artifact(api, 'artifact-lantern').maker).toBe('H. B. Cooke & Sons');
    // Only the external edit was recorded; the stale confirm wrote nothing.
    expect(api().commandLog).toHaveLength(1);
    expect(api().commandLog[0].details).toBeUndefined();
  });

  it('rejects invalid drafts with the full editor field rules and writes no record', () => {
    const api = setup();
    const lantern = artifact(api, 'artifact-lantern');
    const radio = artifact(api, 'artifact-radio');
    const draft = {
      ...artifactToDraft(lantern),
      accessionId: radio.accessionId,
      title: '',
      dwellMinutes: '0',
      summary: 'short',
    };

    let preview: ReturnType<WorkspaceApi['previewArtifactChange']> | undefined;
    act(() => { preview = api().previewArtifactChange(draft, lantern); });
    expect(preview?.ok).toBe(false);
    expect(preview?.value).toBeUndefined();
    expect(preview?.errors?.title).toBeTruthy();
    expect(preview?.errors?.dwellMinutes).toBeTruthy();
    expect(preview?.errors?.summary).toBeTruthy();
    expect(preview?.errors?.accessionId).toBe('This accession ID is already in the collection.');

    let commit: CommitArtifactResult | undefined;
    act(() => { commit = api().commitArtifactChange(draft, lantern, impactBaseVersion(api().state)); });
    expect(commit?.ok).toBe(false);
    expect(commit?.stale).toBeUndefined();
    expect(commit?.errors?.title).toBeTruthy();

    expect(artifact(api, 'artifact-lantern').dwellMinutes).toBe(4);
    expect(api().commandLog).toHaveLength(0);
  });
});
