import { describe, expect, it } from 'vitest';
import type { Artifact, CollectionFilter } from './models';
import {
  createCollectionView,
  describeRulesBasis,
  evaluateFrozenView,
  evaluateLiveView,
  findViewNameConflict,
  isCollectionFilter,
  latestRuleVersion,
  reviseLiveView,
} from './collectionViews';
import { createSeedWorkspace } from '../state/seed';

const seed = createSeedWorkspace();
const artifacts: Artifact[] = seed.artifacts;
const AT = '2026-09-10T10:00:00.000Z';

function artifactWith(id: string, patch: Partial<Artifact> = {}): Artifact {
  const base = artifacts.find((artifact) => artifact.id === id) ?? artifacts[0];
  return { ...base, ...patch };
}

const reflectionRules: CollectionFilter = { query: '', roles: ['reflection'], sensitivities: [], keyOnly: false };

describe('saved collection views', () => {
  it('describes the basis a rule set was created from', () => {
    expect(describeRulesBasis({ query: '', roles: [], sensitivities: [], keyOnly: false })).toBe('all collection objects');
    expect(describeRulesBasis(reflectionRules)).toBe('1 role filter');
    expect(describeRulesBasis({ query: ' tape ', roles: ['context'], sensitivities: ['low-light'], keyOnly: true }))
      .toBe('query “tape”, 1 role filter, 1 sensitivity filter, key objects only');
  });

  it('creates a live view with a versioned rule set and member identity', () => {
    const view = createCollectionView({ id: 'view-live-1', name: 'Reflection live', kind: 'live', rules: reflectionRules, artifacts, at: AT });
    expect(view.kind).toBe('live');
    expect(view.frozenMembers).toBeUndefined();
    expect(view.ruleVersions).toHaveLength(1);
    const version = latestRuleVersion(view);
    expect(version.version).toBe(1);
    expect(version.basis).toBe('1 role filter');
    expect(version.memberIds).toEqual(['artifact-bowl', 'artifact-tape', 'artifact-gloves']);
  });

  it('recomputes live membership when an object changes role or is removed', () => {
    const view = createCollectionView({ id: 'view-live-2', name: 'Reflection live', kind: 'live', rules: reflectionRules, artifacts, at: AT });

    // Role change: the lantern becomes a reflection object, so the live view gains it.
    const roleChanged = artifacts.map((artifact) =>
      artifact.id === 'artifact-lantern' ? artifactWith('artifact-lantern', { narrativeRole: 'reflection' }) : artifact);
    let members = evaluateLiveView(view, roleChanged);
    expect(members.map((artifact) => artifact.id).sort()).toEqual(['artifact-bowl', 'artifact-gloves', 'artifact-lantern', 'artifact-tape'].sort());

    // Deletion: live membership drops the tape.
    const afterDelete = roleChanged.filter((artifact) => artifact.id !== 'artifact-tape');
    members = evaluateLiveView(view, afterDelete);
    expect(members.map((artifact) => artifact.id)).not.toContain('artifact-tape');
    expect(members).toHaveLength(3);

    // An accession ID correction does not change rule membership.
    const correctedId = afterDelete.map((artifact) =>
      artifact.id === 'artifact-bowl' ? artifactWith('artifact-bowl', { accessionId: 'AF-1987-064X' }) : artifact);
    expect(evaluateLiveView(view, correctedId).map((artifact) => artifact.id)).toContain('artifact-bowl');
  });

  it('records a new rule version (with its own membership and basis) when a live view is revised', () => {
    const view = createCollectionView({ id: 'view-live-3', name: 'Reflection live', kind: 'live', rules: reflectionRules, artifacts, at: AT });
    const revised = reviseLiveView(view, { query: '', roles: ['threshold'], sensitivities: [], keyOnly: false }, artifacts, '2026-09-11T10:00:00.000Z');
    expect(revised.ruleVersions).toHaveLength(2);
    expect(latestRuleVersion(revised).version).toBe(2);
    expect(latestRuleVersion(revised).memberIds).toEqual(['artifact-lantern']);
    // Prior version stays on record unchanged.
    expect(revised.ruleVersions[0].memberIds).toEqual(['artifact-bowl', 'artifact-tape', 'artifact-gloves']);
    expect(() => reviseLiveView({ ...revised, kind: 'frozen' } as unknown as Parameters<typeof reviseLiveView>[0], reflectionRules, artifacts, AT)).toThrow(/Frozen lists/);
  });

  it('creates a frozen list with issued member snapshots that remain stable through collection changes', () => {
    const view = createCollectionView({ id: 'view-frozen-1', name: 'Reflection pack', kind: 'frozen', rules: reflectionRules, artifacts, at: AT });
    expect(view.frozenMembers?.map((member) => member.artifactId)).toEqual(['artifact-bowl', 'artifact-tape', 'artifact-gloves']);

    // A role change and a deletion after issuing: the frozen list keeps exactly its issued members.
    const drifted = artifacts
      .map((artifact) => artifact.id === 'artifact-gloves' ? artifactWith('artifact-gloves', { narrativeRole: 'threshold' }) : artifact)
      .filter((artifact) => artifact.id !== 'artifact-tape');
    const evaluation = evaluateFrozenView(view, drifted);
    expect(evaluation.entries.map((entry) => entry.snapshot.artifactId)).toEqual(['artifact-bowl', 'artifact-tape', 'artifact-gloves']);
    expect(evaluation.isStale).toBe(true);
    expect(evaluation.intactCount).toBe(1);
    expect(evaluation.changedCount).toBe(1);
    expect(evaluation.missingCount).toBe(1);

    const gloves = evaluation.entries.find((entry) => entry.snapshot.artifactId === 'artifact-gloves');
    expect(gloves?.state).toBe('changed');
    expect(gloves?.changedFields).toContain('narrativeRole');

    const tape = evaluation.entries.find((entry) => entry.snapshot.artifactId === 'artifact-tape');
    expect(tape?.state).toBe('missing');
    expect(tape?.current).toBeUndefined();
    expect(tape?.snapshot.title).toBe('Oral History Tape 12');
  });

  it('flags an accession ID correction as drift while retaining the issued ID', () => {
    const view = createCollectionView({ id: 'view-frozen-2', name: 'Bowl pack', kind: 'frozen', rules: { query: 'bowl', roles: [], sensitivities: [], keyOnly: false }, artifacts, at: AT });
    const corrected = artifacts.map((artifact) =>
      artifact.id === 'artifact-bowl' ? artifactWith('artifact-bowl', { accessionId: 'AF-1987-999' }) : artifact);
    const evaluation = evaluateFrozenView(view, corrected);
    expect(evaluation.isStale).toBe(true);
    const entry = evaluation.entries[0];
    expect(entry.state).toBe('changed');
    expect(entry.changedFields).toEqual(['accessionId']);
    expect(entry.snapshot.accessionId).toBe('AF-1987-064');
    expect(entry.current?.accessionId).toBe('AF-1987-999');
  });

  it('reports newly matching objects separately without merging them into the frozen list', () => {
    const view = createCollectionView({ id: 'view-frozen-3', name: 'Threshold pack', kind: 'frozen', rules: { query: '', roles: ['threshold'], sensitivities: [], keyOnly: false }, artifacts, at: AT });
    const withNewMember = [
      ...artifacts,
      artifactWith('artifact-new', { id: 'artifact-new', accessionId: 'AF-2030-001', title: 'Brand New Threshold', narrativeRole: 'threshold' }),
    ];
    const evaluation = evaluateFrozenView(view, withNewMember);
    expect(evaluation.isStale).toBe(false);
    expect(evaluation.entries.map((entry) => entry.snapshot.artifactId)).toEqual(['artifact-lantern']);
    expect(evaluation.addedArtifacts.map((artifact) => artifact.id)).toEqual(['artifact-new']);
  });

  it('supports a frozen list issued while no objects match its rules', () => {
    const noMatch: CollectionFilter = { query: 'no-such-object-in-the-collection', roles: [], sensitivities: [], keyOnly: false };
    const view = createCollectionView({ id: 'view-empty', name: 'Empty issue', kind: 'frozen', rules: noMatch, artifacts, at: AT });
    expect(view.frozenMembers).toEqual([]);
    const evaluation = evaluateFrozenView(view, artifacts);
    expect(evaluation.entries).toEqual([]);
    expect(evaluation.isStale).toBe(false);
    // A live object matching later is still not a member of the issued empty list.
    expect(evaluation.addedArtifacts).toHaveLength(0);
  });

  it('enforces unique names across both view kinds so the semantics cannot be confused', () => {
    const live = createCollectionView({ id: 'view-a', name: 'September Review', kind: 'live', rules: reflectionRules, artifacts, at: AT });
    const frozen = createCollectionView({ id: 'view-b', name: 'Loan Pack', kind: 'frozen', rules: reflectionRules, artifacts, at: AT });
    expect(findViewNameConflict([live, frozen], ' september review ')?.id).toBe('view-a');
    expect(findViewNameConflict([live, frozen], 'LOAN PACK')?.kind).toBe('frozen');
    expect(findViewNameConflict([live, frozen], 'September Review', 'view-a')).toBeUndefined();
  });

  it('validates filter rules structurally', () => {
    expect(isCollectionFilter({ query: '', roles: [], sensitivities: [], keyOnly: false })).toBe(true);
    expect(isCollectionFilter(null)).toBe(false);
    expect(isCollectionFilter({ query: 1, roles: [], sensitivities: [], keyOnly: false })).toBe(false);
    expect(isCollectionFilter({ query: '', roles: ['context'], sensitivities: [], keyOnly: false })).toBe(true);
    expect(isCollectionFilter({ query: '', roles: [2], sensitivities: [], keyOnly: false })).toBe(false);
    expect(isCollectionFilter({ query: '', roles: [], sensitivities: [], keyOnly: 'yes' })).toBe(false);
  });
});
