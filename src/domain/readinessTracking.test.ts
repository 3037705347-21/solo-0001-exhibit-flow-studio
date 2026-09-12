import { describe, expect, it } from 'vitest';
import { analyzeJourney } from './journeyAnalysis';
import { evaluateReadiness } from './reviewRules';
import {
  collectReadinessFacts,
  diffReadinessFacts,
  readinessDrift,
  readinessLinkHref,
  readinessLinkStatus,
  summarizeDrift,
} from './readinessTracking';
import { createSeedWorkspace } from '../state/seed';
import type { WorkspaceState } from './models';

function checkedWorkspace(mutate?: (state: WorkspaceState) => WorkspaceState): WorkspaceState {
  const seed = createSeedWorkspace();
  const base = mutate ? mutate(seed) : seed;
  const readiness = evaluateReadiness(base, analyzeJourney(base.artifacts, base.zones), new Date('2026-09-12T09:00:00.000Z'));
  return { ...base, readiness };
}

describe('readiness fact tracking', () => {
  it('collects a deterministic fact set for findings, objects, and zones', () => {
    const state = createSeedWorkspace();
    const first = collectReadinessFacts(state);
    expect(first).toEqual(collectReadinessFacts(state));
    expect(first.map((fact) => fact.key)).toEqual([...first.map((fact) => fact.key)].sort());
  });

  it('reports no drift when nothing changed since the check', () => {
    const state = checkedWorkspace();
    const drift = readinessDrift(state);
    expect(drift).toEqual({ stale: false, changed: [], removed: [], added: [] });
  });

  it('flags an edited object field as a changed dependency', () => {
    const state = checkedWorkspace();
    const edited: WorkspaceState = {
      ...state,
      artifacts: state.artifacts.map((artifact) =>
        artifact.id === 'artifact-bowl' ? { ...artifact, dwellMinutes: 12 } : artifact),
    };
    const drift = readinessDrift(edited);
    expect(drift?.stale).toBe(true);
    expect(drift?.changed).toEqual(['artifact:artifact-bowl']);
    expect(summarizeDrift(drift!, edited)).toContain('Mended Serving Bowl');
  });

  it('flags a finding status change as a changed dependency', () => {
    const state = checkedWorkspace();
    const advanced: WorkspaceState = {
      ...state,
      issues: state.issues.map((issue) =>
        issue.id === 'issue-audio-transcript' ? { ...issue, status: 'resolved' as const } : issue),
    };
    const drift = readinessDrift(advanced);
    expect(drift?.stale).toBe(true);
    expect(drift?.changed).toEqual(['issue:issue-audio-transcript']);
  });

  it('flags placement changes through the zone fact', () => {
    const state = checkedWorkspace();
    const moved: WorkspaceState = {
      ...state,
      zones: state.zones.map((zone) =>
        zone.id === 'zone-arrival' ? { ...zone, artifactIds: [...zone.artifactIds, 'artifact-gloves'] } : zone),
    };
    const drift = readinessDrift(moved);
    expect(drift?.stale).toBe(true);
    expect(drift?.changed).toEqual(['zone:zone-arrival']);
  });

  it('flags removed entities and newly added findings', () => {
    const state = checkedWorkspace();
    const removed: WorkspaceState = {
      ...state,
      artifacts: state.artifacts.filter((artifact) => artifact.id !== 'artifact-tape'),
      issues: state.issues.filter((issue) => issue.artifactId !== 'artifact-tape'),
      zones: state.zones.map((zone) => ({ ...zone, artifactIds: zone.artifactIds.filter((id) => id !== 'artifact-tape') })),
    };
    const drift = readinessDrift(removed);
    expect(drift?.stale).toBe(true);
    expect(drift?.removed).toContain('artifact:artifact-tape');
    expect(drift?.removed).toContain('issue:issue-audio-transcript');
    expect(drift?.changed).toContain('zone:zone-after');

    const now = '2026-09-12T10:00:00.000Z';
    const withIssue: WorkspaceState = {
      ...state,
      issues: [{ id: 'issue-new', title: 'New question', description: 'Needs a decision before install.', severity: 'warning' as const, status: 'open' as const, owner: 'Kai', createdAt: now, updatedAt: now }, ...state.issues],
    };
    expect(readinessDrift(withIssue)?.added).toEqual(['issue:issue-new']);
  });

  it('diffs recorded facts against any current fact set deterministically', () => {
    const recorded = collectReadinessFacts(createSeedWorkspace());
    expect(diffReadinessFacts(recorded, recorded).stale).toBe(false);
    const reordered = [...recorded].reverse();
    expect(diffReadinessFacts(recorded, reordered).stale).toBe(false);
  });
});

describe('readiness blocker links', () => {
  it('resolves ok for untouched targets', () => {
    const state = checkedWorkspace();
    const blocker = state.readiness!.blockers.find((candidate) => candidate.id === 'critical-findings')!;
    expect(readinessLinkStatus(blocker.links[0], state)).toBe('ok');
  });

  it('marks deleted targets as missing so the user is sent back to re-check', () => {
    const state = checkedWorkspace();
    const blocker = state.readiness!.blockers.find((candidate) => candidate.id === 'critical-findings')!;
    const without: WorkspaceState = {
      ...state,
      artifacts: state.artifacts.filter((artifact) => artifact.id !== 'artifact-tape'),
      issues: state.issues.filter((issue) => issue.id !== 'issue-audio-transcript'),
    };
    expect(readinessLinkStatus(blocker.links[0], without)).toBe('missing');
  });

  it('marks edited targets as changed', () => {
    const state = checkedWorkspace();
    const blocker = state.readiness!.blockers.find((candidate) => candidate.id === 'critical-findings')!;
    const edited: WorkspaceState = {
      ...state,
      issues: state.issues.map((issue) =>
        issue.id === 'issue-audio-transcript' ? { ...issue, status: 'resolved' as const } : issue),
    };
    expect(readinessLinkStatus(blocker.links[0], edited)).toBe('changed');
  });

  it('builds deep links with a return path for each target kind', () => {
    expect(readinessLinkHref({ kind: 'zone', id: 'zone-after', label: 'Afterlives' }, 'journey-constraints'))
      .toBe('/journey?from=readiness&blocker=journey-constraints&zone=zone-after');
    expect(readinessLinkHref({ kind: 'artifact', id: 'artifact-bowl', label: 'Bowl' }, 'key-objects'))
      .toBe('/collection?from=readiness&blocker=key-objects&artifact=artifact-bowl');
    expect(readinessLinkHref({ kind: 'issue', id: 'issue-audio-transcript', label: 'Transcript' }, 'critical-findings'))
      .toBe('/review?issue=issue-audio-transcript');
    expect(readinessLinkHref({ kind: 'journey', label: 'Open planner' }, 'empty-journey'))
      .toBe('/journey?from=readiness&blocker=empty-journey');
  });
});
