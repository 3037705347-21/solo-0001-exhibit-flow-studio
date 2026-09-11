import { needLabel } from './accessibility';
import { createId } from './ids';
import type { AccessibilityNeed, Artifact, IssueSeverity, ReviewIssue, WorkspaceState, Zone } from './models';

/**
 * Accessibility remediation transaction.
 *
 * Coverage gaps discovered by the accessibility audit are turned into a single,
 * atomic batch of review findings. The transaction is the only place that may
 * create remediation findings, so coverage, the review list, and readiness all
 * reason about the same object facts: a gap is identified by the object and the
 * requirement it still owes, never by a mutable zone snapshot.
 */

export const REMEDIATION_ORIGIN = 'accessibility-remediation' as const;
export const REMEDIATION_SEVERITY: IssueSeverity = 'warning';

export interface CoverageGap {
  /** Stable identity of the gap: object + requirement still owed. */
  key: string;
  artifactId: string;
  accessionId: string;
  artifactTitle: string;
  need: AccessibilityNeed;
  requirement: string;
  /** Zone the object is currently placed in, when it is placed at all. */
  zoneId?: string;
  zoneName?: string;
}

export interface RemediationSelection {
  key: string;
  owner: string;
  /** Reference fingerprint captured when the gap was selected. */
  fingerprint: string;
}

export interface RemediationRequest {
  selections: RemediationSelection[];
}

export interface RemediationFailure {
  code: 'empty-selection' | 'missing-owner' | 'gap-not-found' | 'reference-changed' | 'duplicate-finding';
  message: string;
  key?: string;
}

export type RemediationResult =
  | { ok: true; issues: ReviewIssue[] }
  | { ok: false; failure: RemediationFailure };

const NEED_DETAIL: Record<Exclude<AccessibilityNeed, 'none'>, string> = {
  seating: 'Add seating to the zone or move the object to a zone with seating so visitors can sit during interpretation.',
  audio: 'Provide an audio interpretation station for this object before the plan is finalized.',
  'tactile-alternative': 'Provide a tactile alternative so visitors who cannot see the object can engage with it.',
};

/**
 * Build the remediation key shared by a coverage gap and every finding raised
 * for it. Object movement never changes it: the requirement is attached to the
 * object, not to a zone assignment.
 */
export function remediationKey(artifactId: string, need: AccessibilityNeed): string {
  return `access-gap:${artifactId}:${need}`;
}

function zoneForArtifact(state: WorkspaceState, artifactId: string): Zone | undefined {
  return state.zones.find((zone) => zone.artifactIds.includes(artifactId));
}

function gapForArtifact(artifact: Artifact, state: WorkspaceState): CoverageGap | null {
  if (artifact.accessibilityNeed === 'none') return null;
  const zone = zoneForArtifact(state, artifact.id);
  const covered = zone
    ? artifact.accessibilityNeed === 'seating'
      ? zone.hasSeating
      : true
    : false;
  if (covered) return null;
  const need = artifact.accessibilityNeed;
  return {
    key: remediationKey(artifact.id, need),
    artifactId: artifact.id,
    accessionId: artifact.accessionId,
    artifactTitle: artifact.title,
    need,
    requirement: needLabel(need),
    zoneId: zone?.id,
    zoneName: zone?.name,
  };
}

/** Current accessibility coverage gaps, computed from one set of object facts. */
export function getCoverageGaps(state: WorkspaceState): CoverageGap[] {
  return state.artifacts
    .map((artifact) => gapForArtifact(artifact, state))
    .filter((gap): gap is CoverageGap => gap !== null);
}

/** True when an unresolved finding already tracks this exact gap. */
export function hasOpenRemediation(state: WorkspaceState, key: string): boolean {
  return state.issues.some(
    (issue) => issue.remediationKey === key && issue.status !== 'resolved',
  );
}

/**
 * Fingerprint of the object facts a selection was based on. Recomputed at commit
 * time; a mismatch means the object, its need, or its placement changed while
 * the batch was open, and the whole batch must be rejected.
 */
export function gapFingerprint(state: WorkspaceState, key: string): string | null {
  const gap = getCoverageGaps(state).find((candidate) => candidate.key === key);
  if (!gap) return null;
  const artifact = state.artifacts.find((candidate) => candidate.id === gap.artifactId);
  if (!artifact) return null;
  return JSON.stringify({
    artifactId: artifact.id,
    need: artifact.accessibilityNeed,
    zoneId: gap.zoneId ?? null,
    title: artifact.title,
  });
}

export function issueTitleForGap(gap: CoverageGap): string {
  return `Access remediation: ${gap.artifactTitle}`;
}

export function issueDescriptionForGap(gap: CoverageGap, owner: string): string {
  const location = gap.zoneName ? `currently placed in ${gap.zoneName}` : 'currently unplaced';
  return `${gap.requirement} is required for ${gap.artifactTitle} (${gap.accessionId}), ${location}. ${NEED_DETAIL[gap.need]} Owner: ${owner}.`;
}

function buildIssue(gap: CoverageGap, owner: string, now: Date): ReviewIssue {
  const timestamp = now.toISOString();
  return {
    id: createId('issue'),
    title: issueTitleForGap(gap),
    description: issueDescriptionForGap(gap, owner),
    severity: REMEDIATION_SEVERITY,
    status: 'open',
    zoneId: gap.zoneId,
    artifactId: gap.artifactId,
    owner,
    remediationKey: gap.key,
    origin: REMEDIATION_ORIGIN,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * Commit the remediation batch against the latest state.
 *
 * The batch is all-or-nothing: an empty selection, a missing owner, a gap that
 * vanished, a stale reference fingerprint, or an already-open finding for the
 * same gap rejects the entire request and returns the state untouched.
 */
export function commitAccessRemediation(
  state: WorkspaceState,
  request: RemediationRequest,
  at: Date = new Date(),
): { state: WorkspaceState; result: RemediationResult } {
  const fail = (failure: RemediationFailure): { state: WorkspaceState; result: RemediationResult } => ({
    state,
    result: { ok: false, failure },
  });

  if (request.selections.length === 0) {
    return fail({ code: 'empty-selection', message: 'Select at least one coverage gap to remediate.' });
  }

  for (const selection of request.selections) {
    if (!selection.owner.trim()) {
      return fail({ code: 'missing-owner', message: 'Assign an owner to every selected gap.', key: selection.key });
    }
  }

  const gaps = getCoverageGaps(state);
  const gapByKey = new Map(gaps.map((gap) => [gap.key, gap]));
  const seenKeys = new Set<string>();

  for (const selection of request.selections) {
    if (seenKeys.has(selection.key)) {
      const duplicateGap = gapByKey.get(selection.key);
      return fail({
        code: 'duplicate-finding',
        message: `${duplicateGap?.artifactTitle ?? 'A selected gap'} appears more than once in this batch.`,
        key: selection.key,
      });
    }
    seenKeys.add(selection.key);
    const gap = gapByKey.get(selection.key);
    if (!gap) {
      return fail({ code: 'gap-not-found', message: 'A selected coverage gap no longer exists. Review the current coverage and retry.', key: selection.key });
    }
    const fingerprint = gapFingerprint(state, selection.key);
    if (fingerprint !== selection.fingerprint) {
      return fail({ code: 'reference-changed', message: `The object or placement behind “${gap.artifactTitle}” changed. Review the current coverage and retry.`, key: selection.key });
    }
    if (hasOpenRemediation(state, selection.key)) {
      return fail({
        code: 'duplicate-finding',
        message: `An unresolved finding already covers ${gap.artifactTitle} (${gap.requirement}).`,
        key: selection.key,
      });
    }
  }

  const issues = request.selections.map((selection) => {
    const gap = gapByKey.get(selection.key) as CoverageGap;
    return buildIssue(gap, selection.owner.trim(), at);
  });

  return {
    state: { ...state, issues: [...issues, ...state.issues] },
    result: { ok: true, issues },
  };
}
