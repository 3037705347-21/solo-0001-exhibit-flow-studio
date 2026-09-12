import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PlanningPreferences } from '../domain/models';
import { planVersion } from '../domain/scenarioDraft';
import { WorkspaceProvider, useWorkspace } from './WorkspaceContext';

type Workspace = ReturnType<typeof useWorkspace>;
type ApplyResult = ReturnType<Workspace['applyPreferences']>;

const candidate: PlanningPreferences = { pace: 'leisurely', accessibilityPriority: 40, groupSize: 12 };

let latest: Workspace | null = null;

function Probe() {
  latest = useWorkspace();
  return null;
}

function renderWorkspace() {
  render(<WorkspaceProvider><Probe /></WorkspaceProvider>);
  if (!latest) throw new Error('Workspace probe did not mount.');
  return latest;
}

describe('applyPreferences command', () => {
  beforeEach(() => {
    localStorage.clear();
    latest = null;
  });

  it('applies a valid draft based on the current plan version', () => {
    renderWorkspace();
    let result: ApplyResult | undefined;
    act(() => { result = latest!.applyPreferences(candidate, planVersion(latest!.state)); });
    expect(result).toMatchObject({ ok: true, value: { applied: true } });
    expect(latest!.state.preferences).toEqual(candidate);
  });

  it('refuses to write when the plan changed since the draft was saved', () => {
    renderWorkspace();
    const before = latest!.state;
    let result: ApplyResult | undefined;
    act(() => { result = latest!.applyPreferences(candidate, 'plan-outdated'); });
    expect(result).toMatchObject({ ok: false, code: 'stale' });
    expect(latest!.state).toBe(before);
    expect(latest!.state.preferences.pace).toBe('balanced');
  });

  it('refuses values that are no longer valid scenario input', () => {
    renderWorkspace();
    const before = latest!.state;
    let result: ApplyResult | undefined;
    act(() => { result = latest!.applyPreferences({ ...candidate, groupSize: 500 }, planVersion(latest!.state)); });
    expect(result).toMatchObject({ ok: false, code: 'invalid' });
    expect(latest!.state).toBe(before);
  });

  it('collapses repeated submissions into a single preference update', () => {
    renderWorkspace();
    const version = planVersion(latest!.state);
    let first: ApplyResult | undefined;
    let second: ApplyResult | undefined;
    act(() => { first = latest!.applyPreferences(candidate, version); });
    const savedAt = latest!.state.lastSavedAt;
    act(() => { second = latest!.applyPreferences(candidate, version); });
    expect(first).toMatchObject({ ok: true, value: { applied: true } });
    expect(second).toMatchObject({ ok: true, value: { applied: false } });
    expect(latest!.state.preferences).toEqual(candidate);
    expect(latest!.state.lastSavedAt).toBe(savedAt);
  });
});
