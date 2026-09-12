import { describe, expect, it } from 'vitest';
import { analyzeJourney } from './journeyAnalysis';
import {
  activeIssues,
  commitMerge,
  isCanonicalRecord,
  isMergedSource,
  issueArtifactIds,
  issueZoneIds,
  prepareMerge,
  resolveCanonicalId,
  type MergePreview,
} from './mergeIssues';
import type { ReviewIssue, WorkspaceState } from './models';
import { buildSnapshot, evaluateReadiness } from './reviewRules';
import { transitionIssue } from './transitions';
import { validateReferences } from '../state/migrations';
import { createSeedWorkspace } from '../state/seed';

const MERGE_AT = new Date('2026-09-10T10:00:00.000Z');
let canonicalCounter = 0;
const idFactory = () => `issue-canonical-${++canonicalCounter}`;

function makeIssue(overrides: Partial<ReviewIssue> & Pick<ReviewIssue, 'id' | 'title'>): ReviewIssue {
  return {
    description: 'Enough context for a review finding used in tests.',
    severity: 'warning',
    status: 'open',
    owner: 'Jo Renner',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

function stateWith(issues: ReviewIssue[]): WorkspaceState {
  return { ...createSeedWorkspace(), issues };
}

function previewOf(state: WorkspaceState, ids: string[]): MergePreview {
  const result = prepareMerge(state, ids);
  if (!result.ok) throw new Error(`prepareMerge failed: ${result.message}`);
  return result.preview;
}

function merge(state: WorkspaceState, ids: string[], reason = 'Same underlying problem reported twice.') {
  const preview = previewOf(state, ids);
  return commitMerge(state, {
    sourceIds: ids,
    reason,
    expectedFingerprint: preview.fingerprint,
    at: MERGE_AT,
    idFactory,
  });
}

describe('prepareMerge', () => {
  it('rejects selections with fewer than two unmerged findings', () => {
    const state = stateWith([makeIssue({ id: 'a', title: 'A' })]);
    const result = prepareMerge(state, ['a']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('at least two');
  });

  it('rejects selections referencing a finding that no longer exists', () => {
    const state = stateWith([makeIssue({ id: 'a', title: 'A' }), makeIssue({ id: 'b', title: 'B' })]);
    const result = prepareMerge(state, ['a', 'ghost']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('no longer exists');
  });

  it('exposes the common root cause, field differences, links and status history', () => {
    const a = makeIssue({ id: 'a', title: 'Lux too high on quilt', severity: 'note', zoneId: 'zone-common', artifactId: 'artifact-quilt' });
    const b = makeIssue({ id: 'b', title: 'Quilt light check', severity: 'critical', status: 'in-progress', zoneId: 'zone-common', artifactId: 'artifact-quilt', owner: 'Rina Solberg' });
    const preview = previewOf(stateWith([a, b]), ['a', 'b']);

    expect(preview.mode).toBe('create');
    expect(preview.sharedZoneIds).toEqual(['zone-common']);
    expect(preview.sharedArtifactIds).toEqual(['artifact-quilt']);
    expect(preview.linkedZoneIds).toEqual(['zone-common']);
    expect(preview.linkedArtifactIds).toEqual(['artifact-quilt']);
    expect(preview.resultingSeverity).toBe('critical');
    expect(preview.resultingStatus).toBe('in-progress');

    const severityDiff = preview.fieldDiffs.find((diff) => diff.field === 'severity');
    const zoneDiff = preview.fieldDiffs.find((diff) => diff.field === 'zoneId');
    const ownerDiff = preview.fieldDiffs.find((diff) => diff.field === 'owner');
    expect(severityDiff?.differs).toBe(true);
    expect(zoneDiff?.differs).toBe(false);
    expect(ownerDiff?.differs).toBe(true);

    expect(preview.statusHistory).toHaveLength(2);
    expect(preview.statusHistory.map((entry) => entry.status).sort()).toEqual(['in-progress', 'open']);
  });
});

describe('commitMerge', () => {
  it('combines different severities into one canonical record at the highest severity', () => {
    const a = makeIssue({ id: 'a', title: 'Note about quilt lux', severity: 'note', zoneId: 'zone-common', artifactId: 'artifact-quilt' });
    const b = makeIssue({ id: 'b', title: 'Warning about quilt lux', severity: 'warning', zoneId: 'zone-common', artifactId: 'artifact-quilt' });
    const c = makeIssue({ id: 'c', title: 'Critical quilt lux failure', severity: 'critical', zoneId: 'zone-common', artifactId: 'artifact-quilt' });
    const result = merge(stateWith([a, b, c]), ['a', 'b', 'c']);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe('create');
    expect(result.changed).toBe(true);
    expect(result.canonical.severity).toBe('critical');
    expect(result.canonical.merge?.mergedFrom.sort()).toEqual(['a', 'b', 'c']);
    expect(result.canonical.merge?.reason).toContain('Same underlying problem');
    expect(result.sources).toHaveLength(3);
    // Sources are kept, marked, and otherwise untouched — no severity is lost.
    expect(result.state.issues.find((issue) => issue.id === 'a')?.severity).toBe('note');
    expect(result.state.issues.find((issue) => issue.id === 'b')?.severity).toBe('warning');
    expect(result.state.issues.find((issue) => issue.id === 'c')?.severity).toBe('critical');
    for (const source of result.sources) {
      expect(source.mergedIntoId).toBe(result.canonical.id);
    }
    // Exactly one canonical record and three sources remain; active count drops to one.
    expect(result.state.issues).toHaveLength(4);
    expect(activeIssues(result.state.issues)).toHaveLength(1);
    expect(result.state.issues.filter(isCanonicalRecord)).toHaveLength(1);
  });

  it('preserves the original evidence of every source in the canonical description', () => {
    const a = makeIssue({ id: 'a', title: 'Primary report', description: 'First account of the lighting problem.' });
    const b = makeIssue({ id: 'b', title: 'Duplicate report', owner: 'Mara Chen', description: 'Second account with extra measurements.' });
    const result = merge(stateWith([a, b]), ['a', 'b'], 'Duplicate of the same lighting issue.');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canonical.title).toBe('Primary report');
    expect(result.canonical.description).toContain('First account of the lighting problem.');
    expect(result.canonical.description).toContain('Merged evidence');
    expect(result.canonical.description).toContain('Duplicate report');
    expect(result.canonical.description).toContain('Second account with extra measurements.');
    // The source record itself keeps its own description untouched.
    const source = result.state.issues.find((issue) => issue.id === 'b');
    expect(source?.description).toBe('Second account with extra measurements.');
    expect(source?.owner).toBe('Mara Chen');
  });

  it('derives a resolved canonical record when every source is resolved', () => {
    const a = makeIssue({ id: 'a', title: 'A', status: 'resolved', resolvedAt: '2026-09-02T10:00:00.000Z' });
    const b = makeIssue({ id: 'b', title: 'B', status: 'resolved', resolvedAt: '2026-09-05T10:00:00.000Z' });
    const result = merge(stateWith([a, b]), ['a', 'b']);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canonical.status).toBe('resolved');
    expect(result.canonical.resolvedAt).toBe('2026-09-05T10:00:00.000Z');
    // Sources keep their own resolved state as evidence.
    expect(result.state.issues.find((issue) => issue.id === 'a')?.status).toBe('resolved');
  });

  it('keeps the canonical record open when only some sources are resolved', () => {
    const resolved = makeIssue({ id: 'a', title: 'A', status: 'resolved', resolvedAt: '2026-09-02T10:00:00.000Z' });
    const open = makeIssue({ id: 'b', title: 'B', status: 'open' });
    const inProgress = makeIssue({ id: 'c', title: 'C', status: 'in-progress' });

    const mixed = merge(stateWith([resolved, open]), ['a', 'b']);
    expect(mixed.ok).toBe(true);
    if (mixed.ok) {
      expect(mixed.canonical.status).toBe('open');
      expect(mixed.canonical.resolvedAt).toBeUndefined();
    }

    const working = merge(stateWith([resolved, inProgress]), ['a', 'c']);
    expect(working.ok).toBe(true);
    if (working.ok) expect(working.canonical.status).toBe('in-progress');
  });

  it('does not create a second canonical record when the same merge runs again', () => {
    const a = makeIssue({ id: 'a', title: 'A' });
    const b = makeIssue({ id: 'b', title: 'B' });
    const first = merge(stateWith([a, b]), ['a', 'b']);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = merge(first.state, ['a', 'b'], 'Attempted repeat of the same merge.');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.mode).toBe('noop');
    expect(second.changed).toBe(false);
    expect(second.canonical.id).toBe(first.canonical.id);
    expect(second.state.issues).toHaveLength(first.state.issues.length);
    expect(second.state.issues.filter(isCanonicalRecord)).toHaveLength(1);
  });

  it('absorbs new duplicates into the existing canonical record instead of creating one', () => {
    const a = makeIssue({ id: 'a', title: 'A', severity: 'note' });
    const b = makeIssue({ id: 'b', title: 'B' });
    const first = merge(stateWith([a, b]), ['a', 'b']);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const late = makeIssue({ id: 'late', title: 'Late duplicate', severity: 'critical' });
    const withLate: WorkspaceState = { ...first.state, issues: [late, ...first.state.issues] };
    const preview = previewOf(withLate, ['late', 'a']);
    expect(preview.mode).toBe('absorb');
    expect(preview.existingCanonicalId).toBe(first.canonical.id);

    const second = commitMerge(withLate, {
      sourceIds: ['late', 'a'],
      reason: 'Another report of the same problem.',
      expectedFingerprint: preview.fingerprint,
      at: MERGE_AT,
      idFactory,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.mode).toBe('absorb');
    expect(second.canonical.id).toBe(first.canonical.id);
    expect(second.canonical.severity).toBe('critical');
    expect(second.canonical.merge?.mergedFrom.sort()).toEqual(['a', 'b', 'late']);
    expect(second.state.issues.filter(isCanonicalRecord)).toHaveLength(1);
    expect(second.state.issues.find((issue) => issue.id === 'late')?.mergedIntoId).toBe(first.canonical.id);
  });

  it('rejects merging findings that belong to different canonical records', () => {
    const a = makeIssue({ id: 'a', title: 'A' });
    const b = makeIssue({ id: 'b', title: 'B' });
    const c = makeIssue({ id: 'c', title: 'C' });
    const d = makeIssue({ id: 'd', title: 'D' });
    const first = merge(stateWith([a, b, c, d]), ['a', 'b']);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = merge(first.state, ['c', 'd']);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const preview = prepareMerge(second.state, ['a', 'c']);
    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(preview.message).toContain('different canonical records');

    const conflict = commitMerge(second.state, {
      sourceIds: ['a', 'c'],
      reason: 'Trying to combine two merge groups.',
      expectedFingerprint: 'irrelevant',
      at: MERGE_AT,
      idFactory,
    });
    expect(conflict.ok).toBe(false);
    // Both sources keep pointing at their own canonical records; nothing moved.
    expect(second.state.issues.find((issue) => issue.id === 'a')?.mergedIntoId).toBe(first.canonical.id);
    expect(second.state.issues.find((issue) => issue.id === 'c')?.mergedIntoId).toBe(second.canonical.id);
    expect(second.state.issues.filter(isCanonicalRecord)).toHaveLength(2);
  });

  it('aborts when a finding changed between preview and confirm, leaving sources untouched', () => {
    const a = makeIssue({ id: 'a', title: 'A' });
    const b = makeIssue({ id: 'b', title: 'B' });
    const state = stateWith([a, b]);
    const preview = previewOf(state, ['a', 'b']);

    // An external transition lands after the preview was generated.
    const externallyChanged: WorkspaceState = {
      ...state,
      issues: state.issues.map((issue) =>
        issue.id === 'b' ? transitionIssue(issue, 'in-progress', new Date('2026-09-11T08:00:00.000Z')) : issue,
      ),
    };
    const result = commitMerge(externallyChanged, {
      sourceIds: ['a', 'b'],
      reason: 'Merge attempted against a stale preview.',
      expectedFingerprint: preview.fingerprint,
      at: MERGE_AT,
      idFactory,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('changed since the preview');
    // The sources stay exactly as the external change left them.
    expect(externallyChanged.issues.find((issue) => issue.id === 'b')?.status).toBe('in-progress');
    expect(externallyChanged.issues.every((issue) => !isMergedSource(issue))).toBe(true);
    expect(externallyChanged.issues.filter(isCanonicalRecord)).toHaveLength(0);
  });

  it('rejects a merge without a reason', () => {
    const a = makeIssue({ id: 'a', title: 'A' });
    const b = makeIssue({ id: 'b', title: 'B' });
    const state = stateWith([a, b]);
    const preview = previewOf(state, ['a', 'b']);
    const result = commitMerge(state, { sourceIds: ['a', 'b'], reason: '   ', expectedFingerprint: preview.fingerprint, at: MERGE_AT, idFactory });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('reason');
    expect(state.issues.every((issue) => !isMergedSource(issue))).toBe(true);
  });

  it('fails post-merge validation and keeps sources untouched when links dangle', () => {
    const a = makeIssue({ id: 'a', title: 'A', zoneId: 'zone-ghost' });
    const b = makeIssue({ id: 'b', title: 'B' });
    const state = stateWith([a, b]);
    const result = merge(state, ['a', 'b']);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Merge validation failed');
    // Sources were not marked and no canonical record leaked into the state.
    expect(state.issues.find((issue) => issue.id === 'a')?.mergedIntoId).toBeUndefined();
    expect(state.issues.filter(isCanonicalRecord)).toHaveLength(0);
  });
});

describe('canonical references', () => {
  it('redirects references to source records at the canonical record', () => {
    const a = makeIssue({ id: 'a', title: 'A' });
    const b = makeIssue({ id: 'b', title: 'B' });
    const result = merge(stateWith([a, b]), ['a', 'b']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(resolveCanonicalId(result.state.issues, 'a')).toBe(result.canonical.id);
    expect(resolveCanonicalId(result.state.issues, 'b')).toBe(result.canonical.id);
    expect(resolveCanonicalId(result.state.issues, result.canonical.id)).toBe(result.canonical.id);
  });

  it('cleans dangling merge references when a workspace is loaded', () => {
    const seed = createSeedWorkspace();
    const danglingSource = makeIssue({ id: 'src', title: 'Dangling source', mergedIntoId: 'missing-canonical' });
    const canonical = makeIssue({
      id: 'can',
      title: 'Canonical',
      merge: {
        canonicalId: 'can',
        mergedFrom: ['src', 'ghost'],
        reason: 'Pruned references.',
        mergedAt: '2026-09-10T10:00:00.000Z',
        linkedZoneIds: ['zone-ghost'],
        linkedArtifactIds: ['artifact-ghost'],
      },
    });
    const cleaned = validateReferences({ ...seed, issues: [danglingSource, canonical] });

    expect(cleaned.issues.find((issue) => issue.id === 'src')?.mergedIntoId).toBeUndefined();
    const cleanedCanonical = cleaned.issues.find((issue) => issue.id === 'can');
    expect(cleanedCanonical?.merge?.mergedFrom).toEqual(['src']);
    expect(cleanedCanonical?.merge?.linkedZoneIds).toEqual([]);
    expect(cleanedCanonical?.merge?.linkedArtifactIds).toEqual([]);
  });

  it('exposes the union of linked zones and objects on the canonical record', () => {
    const a = makeIssue({ id: 'a', title: 'A', zoneId: 'zone-common', artifactId: 'artifact-quilt' });
    const b = makeIssue({ id: 'b', title: 'B', zoneId: 'zone-after', artifactId: 'artifact-tape' });
    const result = merge(stateWith([a, b]), ['a', 'b']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(issueZoneIds(result.canonical).sort()).toEqual(['zone-after', 'zone-common']);
    expect(issueArtifactIds(result.canonical).sort()).toEqual(['artifact-quilt', 'artifact-tape']);
    expect(result.canonical.merge?.linkedZoneIds.sort()).toEqual(['zone-after', 'zone-common']);
  });
});

describe('merge-aware readiness and export', () => {
  it('counts a merged critical finding once through its canonical record', () => {
    const seed = createSeedWorkspace();
    const a = makeIssue({ id: 'a', title: 'Duplicate critical A', severity: 'critical' });
    const b = makeIssue({ id: 'b', title: 'Duplicate critical B', severity: 'critical' });
    const result = merge({ ...seed, issues: [a, b, ...seed.issues] }, ['a', 'b']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const readiness = evaluateReadiness(result.state, analyzeJourney(result.state.artifacts, result.state.zones));
    // Seed has one unresolved critical; the merged pair contributes exactly one more.
    expect(readiness.blockers).toContain('2 critical review findings remain unresolved.');
  });

  it('exports only the canonical record as unresolved, with its merge record attached', () => {
    const seed = createSeedWorkspace();
    const resolvedSeed = {
      ...seed,
      issues: seed.issues.map((issue) => ({ ...issue, status: 'resolved' as const, resolvedAt: '2026-09-01T12:00:00.000Z' })),
    };
    const a = makeIssue({ id: 'a', title: 'Open duplicate A', severity: 'critical' });
    const b = makeIssue({ id: 'b', title: 'Open duplicate B', severity: 'warning' });
    const result = merge({ ...resolvedSeed, issues: [a, b, ...resolvedSeed.issues] }, ['a', 'b']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const analysis = analyzeJourney(result.state.artifacts, result.state.zones);
    const readiness = evaluateReadiness(result.state, analysis);
    // The merged canonical is critical and unresolved, so the plan stays blocked…
    expect(readiness.ready).toBe(false);

    const resolvedCanonical: WorkspaceState = {
      ...result.state,
      issues: result.state.issues.map((issue) =>
        issue.id === result.canonical.id ? { ...issue, status: 'resolved' as const, resolvedAt: '2026-09-12T09:00:00.000Z' } : issue,
      ),
    };
    const cleanAnalysis = analyzeJourney(resolvedCanonical.artifacts, resolvedCanonical.zones);
    const cleanReadiness = evaluateReadiness(resolvedCanonical, cleanAnalysis);
    expect(cleanReadiness.ready).toBe(true);

    const snapshot = buildSnapshot(resolvedCanonical, cleanAnalysis, cleanReadiness);
    // Sources are resolved-by-merge evidence and never exported as open work.
    expect(snapshot.unresolvedIssues).toHaveLength(0);
    expect(snapshot.project.stage).toBe('ready');
  });

  it('keeps merged sources out of the unresolved export while the canonical is open', () => {
    const seed = createSeedWorkspace();
    const a = makeIssue({ id: 'a', title: 'Open duplicate A', severity: 'warning' });
    const b = makeIssue({ id: 'b', title: 'Open duplicate B', severity: 'note' });
    const result = merge({ ...seed, issues: [a, b, ...seed.issues] }, ['a', 'b']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const unresolved = activeIssues(result.state.issues).filter((issue) => issue.status !== 'resolved');
    expect(unresolved.filter((issue) => issue.id === 'a' || issue.id === 'b')).toHaveLength(0);
    expect(unresolved.some((issue) => issue.id === result.canonical.id)).toBe(true);
    expect(result.canonical.merge?.mergedFrom.sort()).toEqual(['a', 'b']);
  });
});
