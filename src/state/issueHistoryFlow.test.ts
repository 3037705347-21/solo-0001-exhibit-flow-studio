import { describe, expect, it } from 'vitest';
import { analyzeJourney } from '../domain/journeyAnalysis';
import { isReconciled, issueFromInput, recordIssueStatus, summarizeHistory } from '../domain/issueHistory';
import type { WorkspaceState } from '../domain/models';
import { evaluateReadiness, buildSnapshot } from '../domain/reviewRules';
import { createSeedWorkspace } from './seed';
import { migrateWorkspace, validateReferences } from './migrations';
import { workspaceReducer } from './reducer';

const clock = (iso: string) => new Date(iso);

describe('finding history through the reducer', () => {
  it('records create, start, resolve, reopen, edit and reassign as ordered immutable events', () => {
    let state: WorkspaceState = createSeedWorkspace();
    const issue = issueFromInput('issue-flow', {
      title: 'Tactile map missing at entry',
      description: 'Visitors arriving at the threshold have no tactile orientation aid.',
      severity: 'critical',
      owner: 'Mara Chen',
      zoneId: 'zone-arrival',
    }, clock('2026-09-05T09:00:00.000Z'));

    state = workspaceReducer(state, { type: 'issue/add', issue });
    state = workspaceReducer(state, { type: 'issue/transition', issueId: issue.id, status: 'in-progress', at: clock('2026-09-05T10:00:00.000Z'), note: 'Sourcing fabricator.' });
    state = workspaceReducer(state, { type: 'issue/transition', issueId: issue.id, status: 'resolved', at: clock('2026-09-06T10:00:00.000Z'), note: 'Map installed.' });
    state = workspaceReducer(state, { type: 'issue/transition', issueId: issue.id, status: 'open', at: clock('2026-09-07T08:00:00.000Z'), note: 'Braille labels faded.' });
    state = workspaceReducer(state, { type: 'issue/edit', issueId: issue.id, patch: { severity: 'warning' }, at: clock('2026-09-07T09:00:00.000Z') });
    state = workspaceReducer(state, { type: 'issue/reassign', issueId: issue.id, owner: 'Rina Solberg', at: clock('2026-09-07T09:30:00.000Z'), note: 'Conservation follow-up.' });
    // Repeated identical operation must append nothing.
    state = workspaceReducer(state, { type: 'issue/reassign', issueId: issue.id, owner: 'Rina Solberg', at: clock('2026-09-07T09:31:00.000Z') });

    const stored = state.issues.find((candidate) => candidate.id === issue.id)!;
    expect(stored.events.map((event) => event.type)).toEqual([
      'created', 'started', 'resolved', 'reopened', 'edited', 'reassigned',
    ]);
    expect(stored.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(stored.status).toBe('open');
    expect(stored.severity).toBe('warning');
    expect(stored.owner).toBe('Rina Solberg');
    expect(stored.resolvedAt).toBeUndefined();
    expect(isReconciled(stored)).toBe(true);

    // Events themselves are immutable: nothing overwrote the first resolution.
    const firstResolution = stored.events[2];
    expect(firstResolution).toMatchObject({ type: 'resolved', note: 'Map installed.' });
    expect(summarizeHistory(stored)).toMatchObject({ eventCount: 6, reopenCount: 1, resolutionCount: 1 });

    // Re-resolving adds a *new* resolution event rather than mutating the old one.
    state = workspaceReducer(state, { type: 'issue/transition', issueId: issue.id, status: 'in-progress', at: clock('2026-09-07T10:00:00.000Z') });
    state = workspaceReducer(state, { type: 'issue/transition', issueId: issue.id, status: 'resolved', at: clock('2026-09-08T10:00:00.000Z'), note: 'Labels re-engraved.' });
    const resolved = state.issues.find((candidate) => candidate.id === issue.id)!;
    expect(resolved.resolvedAt).toBe('2026-09-08T10:00:00.000Z');
    expect(resolved.events.filter((event) => event.type === 'resolved')).toHaveLength(2);
  });

  it('keeps the old resolution reachable in the chain while reopen makes status open', () => {
    let state = createSeedWorkspace();
    const issue = recordIssueStatus(
      recordIssueStatus(
        issueFromInput('issue-reopen', {
          title: 'Seat sightline blocked',
          description: 'The seated interpretation point cannot see the lantern label.',
          severity: 'warning',
          owner: 'Theo James',
        }, clock('2026-09-01T09:00:00.000Z')),
        'in-progress',
        clock('2026-09-01T09:30:00.000Z'),
      ),
      'resolved',
      clock('2026-09-02T09:30:00.000Z'),
    );
    state = workspaceReducer(state, { type: 'issue/add', issue });
    state = workspaceReducer(state, { type: 'issue/transition', issueId: issue.id, status: 'open', at: clock('2026-09-03T09:30:00.000Z'), note: 'Regression after furniture move.' });

    const reopened = state.issues.find((candidate) => candidate.id === issue.id)!;
    expect(reopened.status).toBe('open');
    expect(reopened.resolvedAt).toBeUndefined();
    expect(reopened.events.find((event) => event.type === 'resolved')?.at).toBe('2026-09-02T09:30:00.000Z');
  });
});

describe('legacy workspace migration', () => {
  it('generates a compatible initial record for findings without history', () => {
    const seed = createSeedWorkspace();
    const legacy = JSON.parse(JSON.stringify(seed)) as WorkspaceState;
    legacy.issues = legacy.issues.map((issue) => {
      const { events: _events, ...projection } = issue;
      return projection as typeof issue;
    });

    const migrated = validateReferences(migrateWorkspace(legacy) as WorkspaceState);
    expect(migrated.issues).toHaveLength(legacy.issues.length);
    for (const issue of migrated.issues) {
      expect(issue.events.length).toBeGreaterThanOrEqual(1);
      expect(issue.events[0]).toMatchObject({ type: 'created', backfilled: true });
      const original = legacy.issues.find((candidate) => candidate.id === issue.id)!;
      expect(issue.status).toBe(original.status);
      expect(issue.resolvedAt).toBe(original.resolvedAt);
    }

    // Migrating again must not append duplicate initial records.
    const remigrated = validateReferences(migrateWorkspace(migrated) as WorkspaceState);
    expect(remigrated.issues.every((issue) => issue.events.filter((event) => event.backfilled).length === 1)).toBe(true);
  });
});

describe('snapshot export with decision history', () => {
  it('excludes event chains by default and includes them on demand', () => {
    const state = createSeedWorkspace();
    const analysis = analyzeJourney(state.artifacts, state.zones);

    // Seed has an unresolved critical finding, so readiness is blocked.
    const blocked = evaluateReadiness(state, analysis);
    expect(blocked.ready).toBe(false);

    const readyState: WorkspaceState = {
      ...state,
      issues: state.issues.map((issue) => issue.status !== 'resolved' ? recordIssueStatus(issue, 'in-progress', new Date()) : issue)
        .map((issue) => issue.status !== 'resolved' ? recordIssueStatus(issue, 'resolved', new Date()) : issue),
    };
    const readyAnalysis = analyzeJourney(readyState.artifacts, readyState.zones);
    const readiness = evaluateReadiness(readyState, readyAnalysis);
    expect(readiness.ready).toBe(true);

    const plain = buildSnapshot(readyState, readyAnalysis, readiness);
    expect(plain.issueHistory).toBeUndefined();
    expect(plain.unresolvedIssues).toHaveLength(0);
    expect(plain.unresolvedIssues.every((issue) => !('events' in issue))).toBe(true);

    const withHistory = buildSnapshot(readyState, readyAnalysis, readiness, { includeHistory: true });
    expect(withHistory.issueHistory).toHaveLength(readyState.issues.length);
    for (const exported of withHistory.issueHistory!) {
      expect(exported.events.length).toBeGreaterThanOrEqual(1);
      expect(Object.isFrozen(exported.events)).toBe(false);
      expect(exported.historySummary.eventCount).toBe(exported.events.length);
    }
  });
});
