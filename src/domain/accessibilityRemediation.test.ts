import { describe, expect, it } from 'vitest';
import {
  commitAccessRemediation,
  gapFingerprint,
  getCoverageGaps,
  hasOpenRemediation,
  issueDescriptionForGap,
  issueTitleForGap,
  remediationKey,
  REMEDIATION_ORIGIN,
  type RemediationRequest,
} from './accessibilityRemediation';
import type { WorkspaceState } from './models';
import { createSeedWorkspace } from '../state/seed';

function unplacedGapState(): WorkspaceState {
  // The seed has every recorded requirement covered by placement. Remove the
  // oral-history tape (audio) from its zone to open a fresh coverage gap.
  const state = createSeedWorkspace();
  return {
    ...state,
    zones: state.zones.map((zone) => ({
      ...zone,
      artifactIds: zone.artifactIds.filter((id) => id !== 'artifact-tape'),
    })),
  };
}

function multiGapState(): WorkspaceState {
  const state = unplacedGapState();
  // Quilt needs seating; move it to Arrival, which has no seating.
  return {
    ...state,
    zones: state.zones.map((zone) => ({
      ...zone,
      artifactIds: zone.id === 'zone-common'
        ? zone.artifactIds.filter((id) => id !== 'artifact-quilt')
        : zone.id === 'zone-arrival'
          ? [...zone.artifactIds, 'artifact-quilt']
          : zone.artifactIds,
    })),
  };
}

function selectAll(state: WorkspaceState): RemediationRequest {
  return {
    selections: getCoverageGaps(state).map((gap) => ({
      key: gap.key,
      owner: 'Mara Chen',
      fingerprint: gapFingerprint(state, gap.key) as string,
    })),
  };
}

describe('accessibility remediation transaction', () => {
  it('opens one finding per fresh gap carrying object, zone, requirement, and owner', () => {
    const state = multiGapState();
    const gaps = getCoverageGaps(state);
    expect(gaps.map((gap) => gap.artifactTitle).sort()).toEqual(['Oral History Tape 12', 'Rain Map Quilt']);

    const quiltGap = gaps.find((gap) => gap.artifactId === 'artifact-quilt')!;
    expect(quiltGap.requirement).toBe('Seated interpretation');
    expect(quiltGap.zoneName).toBe('Arrival / A Light Carried');
    const tapeGap = gaps.find((gap) => gap.artifactId === 'artifact-tape')!;
    expect(tapeGap.zoneId).toBeUndefined();

    const { state: nextState, result } = commitAccessRemediation(state, selectAll(state), new Date('2026-09-10T10:00:00.000Z'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.issues).toHaveLength(2);
    expect(nextState.issues).toHaveLength(state.issues.length + 2);

    const quiltIssue = result.issues.find((issue) => issue.artifactId === 'artifact-quilt')!;
    expect(quiltIssue.title).toBe(issueTitleForGap(quiltGap));
    expect(quiltIssue.description).toContain('Seated interpretation is required');
    expect(quiltIssue.description).toContain('Arrival / A Light Carried');
    expect(quiltIssue.description).toContain('Owner: Mara Chen.');
    expect(quiltIssue).toMatchObject({
      severity: 'warning',
      status: 'open',
      owner: 'Mara Chen',
      zoneId: 'zone-arrival',
      origin: REMEDIATION_ORIGIN,
      remediationKey: remediationKey('artifact-quilt', 'seating'),
    });
  });

  it('rejects a gap that already has an unresolved finding without writing anything', () => {
    const state = multiGapState();
    const first = commitAccessRemediation(state, selectAll(state));
    expect(first.result.ok).toBe(true);

    const retry = commitAccessRemediation(first.state, selectAll(first.state));
    expect(retry.result.ok).toBe(false);
    if (retry.result.ok) throw new Error('expected duplicate rejection');
    expect(retry.result.failure.code).toBe('duplicate-finding');
    expect(retry.state.issues).toBe(first.state.issues);
    expect(hasOpenRemediation(first.state, remediationKey('artifact-quilt', 'seating'))).toBe(true);
  });

  it('allows re-opening a gap once its prior finding was resolved', () => {
    const state = unplacedGapState();
    const first = commitAccessRemediation(state, selectAll(state));
    expect(first.result.ok).toBe(true);
    const key = remediationKey('artifact-tape', 'audio');
    const resolved: WorkspaceState = {
      ...first.state,
      issues: first.state.issues.map((issue) =>
        issue.remediationKey === key
          ? { ...issue, status: 'resolved', resolvedAt: '2026-09-10T12:00:00.000Z' }
          : issue,
      ),
    };
    expect(hasOpenRemediation(resolved, key)).toBe(false);
    const retry = commitAccessRemediation(resolved, selectAll(resolved));
    expect(retry.result.ok).toBe(true);
    if (!retry.result.ok) return;
    expect(retry.state.issues.filter((issue) => issue.remediationKey === key)).toHaveLength(2);
  });

  it('aborts the whole batch when a referenced object moves between zones before commit', () => {
    const state = multiGapState();
    const request = selectAll(state);

    // Move the quilt from Arrival to Afterlives after removing its seating, so
    // the same requirement is still owed but the referenced zone changed.
    const changedState: WorkspaceState = {
      ...state,
      zones: state.zones.map((zone) => {
        if (zone.id === 'zone-arrival') {
          return { ...zone, artifactIds: zone.artifactIds.filter((id) => id !== 'artifact-quilt') };
        }
        if (zone.id === 'zone-after') {
          return { ...zone, hasSeating: false, artifactIds: [...zone.artifactIds, 'artifact-quilt'] };
        }
        return zone;
      }),
    };
    const movedGap = getCoverageGaps(changedState).find((gap) => gap.artifactId === 'artifact-quilt');
    expect(movedGap?.zoneId).toBe('zone-after');

    const result = commitAccessRemediation(changedState, request);
    expect(result.result.ok).toBe(false);
    if (result.result.ok) throw new Error('expected reference rejection');
    expect(result.result.failure.code).toBe('reference-changed');
    expect(result.state.issues).toBe(changedState.issues);
  });

  it('aborts the whole batch when a referenced object moves before commit', () => {
    const state = multiGapState();
    const request = selectAll(state);

    // The reviewer moves the quilt back to a seated zone while the dialog is open.
    const changedState: WorkspaceState = {
      ...state,
      zones: state.zones.map((zone) => ({
        ...zone,
        artifactIds: zone.id === 'zone-arrival'
          ? zone.artifactIds.filter((id) => id !== 'artifact-quilt')
          : zone.id === 'zone-common'
            ? [...zone.artifactIds, 'artifact-quilt']
            : zone.artifactIds,
      })),
    };
    // The quilt gap is gone (Common Thread has seating); only the audio gap remains.
    expect(getCoverageGaps(changedState).some((gap) => gap.artifactId === 'artifact-quilt')).toBe(false);

    const result = commitAccessRemediation(changedState, request);
    expect(result.result.ok).toBe(false);
    if (result.result.ok) throw new Error('expected reference rejection');
    expect(['gap-not-found', 'reference-changed']).toContain(result.result.failure.code);
    expect(result.state.issues).toBe(changedState.issues);
  });

  it('aborts the whole batch when the requirement itself changes before commit', () => {
    const state = multiGapState();
    const request = selectAll(state);
    const changedState: WorkspaceState = {
      ...state,
      artifacts: state.artifacts.map((artifact) =>
        artifact.id === 'artifact-tape' ? { ...artifact, accessibilityNeed: 'none' as const } : artifact,
      ),
    };
    const result = commitAccessRemediation(changedState, request);
    expect(result.result.ok).toBe(false);
    if (result.result.ok) throw new Error('expected reference rejection');
    expect(result.result.failure.code).toBe('gap-not-found');
    expect(result.state.issues).toBe(changedState.issues);
  });

  it('never leaves a half batch when one selected gap duplicates another in the same request', () => {
    const state = multiGapState();
    const gaps = getCoverageGaps(state);
    const before = state.issues.length;
    // Seed an open finding for the tape, then submit both gaps together.
    const seeded = commitAccessRemediation(state, {
      selections: [{ key: gaps.find((g) => g.artifactId === 'artifact-tape')!.key, owner: 'Theo James', fingerprint: gapFingerprint(state, gaps.find((g) => g.artifactId === 'artifact-tape')!.key)! }],
    });
    expect(seeded.result.ok).toBe(true);
    const batch = commitAccessRemediation(seeded.state, selectAll(state));
    expect(batch.result.ok).toBe(false);
    if (batch.result.ok) throw new Error('expected all-or-nothing rejection');
    expect(batch.state.issues).toHaveLength(before + 1);
  });

  it('rejects the same gap listed twice within one batch without writing', () => {
    const state = unplacedGapState();
    const gap = getCoverageGaps(state)[0];
    const before = state.issues.length;
    const result = commitAccessRemediation(state, {
      selections: [
        { key: gap.key, owner: 'Mara Chen', fingerprint: gapFingerprint(state, gap.key)! },
        { key: gap.key, owner: 'Theo James', fingerprint: gapFingerprint(state, gap.key)! },
      ],
    });
    expect(result.result.ok).toBe(false);
    if (result.result.ok) throw new Error('expected intra-batch duplicate rejection');
    expect(result.result.failure.code).toBe('duplicate-finding');
    expect(result.state.issues).toHaveLength(before);
  });

  it('rejects empty selections and missing owners without writing', () => {
    const state = unplacedGapState();
    const empty = commitAccessRemediation(state, { selections: [] });
    expect(empty.result.ok).toBe(false);
    if (empty.result.ok) throw new Error('expected empty rejection');
    expect(empty.result.failure.code).toBe('empty-selection');
    expect(empty.state.issues).toBe(state.issues);

    const gap = getCoverageGaps(state)[0];
    const noOwner = commitAccessRemediation(state, {
      selections: [{ key: gap.key, owner: '   ', fingerprint: gapFingerprint(state, gap.key)! }],
    });
    expect(noOwner.result.ok).toBe(false);
    if (noOwner.result.ok) throw new Error('expected owner rejection');
    expect(noOwner.result.failure.code).toBe('missing-owner');
    expect(noOwner.state.issues).toBe(state.issues);
  });

  it('keeps coverage, findings, and readiness on the same object facts', () => {
    const state = multiGapState();
    const gaps = getCoverageGaps(state);
    expect(gaps).toHaveLength(2);
    const committed = commitAccessRemediation(state, selectAll(state));
    expect(committed.result.ok).toBe(true);
    // Every created finding maps back to a live object and zone in state.
    committed.result.ok && committed.result.issues.forEach((issue) => {
      const artifact = state.artifacts.find((candidate) => candidate.id === issue.artifactId);
      expect(artifact).toBeDefined();
      if (issue.zoneId) expect(state.zones.some((zone) => zone.id === issue.zoneId)).toBe(true);
      const description = issueDescriptionForGap(
        gaps.find((gap) => gap.key === issue.remediationKey)!,
        issue.owner,
      );
      expect(issue.description).toBe(description);
    });
  });
});
